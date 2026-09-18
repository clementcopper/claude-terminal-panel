import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getStatusLineRoot } from './statusLineWatcher';
import { log } from './log';

/**
 * A per-model weekly window, e.g. Fable's. `name` is the server's label (`"Fable"`), matched
 * against the start of the model name Claude Code reports (`"Fable 5.1"`).
 */
export interface ModelWeeklyLimit {
  name: string;
  percent: number;
  /** Unix seconds. */
  resetsAt: number;
}

/** Shared by every window, next to `limits.json`. */
export const MODEL_LIMITS_FILE = 'model-limits.json';
/** How often the endpoint is asked. Anthropic's and undocumented, so the rate stays low. */
export const MODEL_LIMITS_POLL_MS = 300_000;
/** A window skips its own fetch when another one wrote the file more recently than this. */
const MODEL_LIMITS_FRESH_MS = 240_000;
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

export function getModelLimitsPath(): string {
  return path.join(getStatusLineRoot(), 'last', MODEL_LIMITS_FILE);
}

/**
 * Claude Code's OAuth access token, read from the keychain item it keeps it in.
 *
 * Read only. The token is never refreshed, written or logged here: Claude Code refreshes it
 * during its own session, and a token that has expired simply means no fetch this round.
 */
function readAccessToken(): Promise<string | undefined> {
  if (process.platform !== 'darwin') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { timeout: 5000 },
      (error, stdout) => {
        if (error) {
          log(
            'usage',
            `no Claude Code credentials in the keychain (${error.message.split('\n')[0]})`
          );
          resolve(undefined);
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as {
            claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown };
          };
          const oauth = parsed.claudeAiOauth;
          const token = typeof oauth?.accessToken === 'string' ? oauth.accessToken : undefined;
          const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : undefined;
          if (token && expiresAt !== undefined && expiresAt <= Date.now()) {
            log('usage', 'access token expired; waiting for Claude Code to refresh it');
            resolve(undefined);
            return;
          }
          resolve(token);
        } catch {
          log('usage', 'keychain item is not the expected JSON');
          resolve(undefined);
        }
      }
    );
  });
}

/**
 * The per-model weekly rows of a `/api/oauth/usage` answer. `undefined` when the shape is not the
 * one measured (2026-09-18, Claude Code 2.1.277) — an empty array when it is and there are none.
 */
export function parseUsage(json: unknown): ModelWeeklyLimit[] | undefined {
  if (typeof json !== 'object' || json === null) return undefined;
  const limits = (json as { limits?: unknown }).limits;
  if (!Array.isArray(limits)) return undefined;

  const rows: ModelWeeklyLimit[] = [];
  for (const entry of limits as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as {
      kind?: unknown;
      percent?: unknown;
      resets_at?: unknown;
      scope?: { model?: { display_name?: unknown } | null } | null;
    };
    const name = row.scope?.model?.display_name;
    if (row.kind !== 'weekly_scoped' || typeof name !== 'string' || name.length === 0) continue;
    if (typeof row.percent !== 'number' || !Number.isFinite(row.percent)) continue;
    const resetsAt = typeof row.resets_at === 'string' ? Date.parse(row.resets_at) : NaN;
    if (!Number.isFinite(resetsAt)) continue;
    rows.push({ name, percent: row.percent, resetsAt: Math.floor(resetsAt / 1000) });
  }
  return rows;
}

/** One request against the usage endpoint. Every failure is one log line and `undefined`. */
export async function fetchModelWeekly(): Promise<ModelWeeklyLimit[] | undefined> {
  const token = await readAccessToken();
  if (!token) return undefined;
  try {
    const response = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {
      log('usage', `usage endpoint answered ${String(response.status)}`);
      return undefined;
    }
    const rows = parseUsage(await response.json());
    if (!rows) {
      log('usage', 'usage endpoint answered in an unknown shape; per-model limits skipped');
    }
    return rows;
  } catch (error) {
    log('usage', `usage endpoint unreachable: ${String(error)}`);
    return undefined;
  }
}

/** When `model-limits.json` was last written, by any window; 0 when never. */
function lastFetchedAt(): number {
  try {
    const parsed = JSON.parse(fs.readFileSync(getModelLimitsPath(), 'utf8')) as {
      fetchedAt?: unknown;
    };
    return typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0;
  } catch {
    return 0;
  }
}

function writeModelLimits(rows: ModelWeeklyLimit[]): void {
  const target = getModelLimitsPath();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.${String(process.pid)}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ rows, fetchedAt: Date.now() }), { mode: 0o600 });
    fs.renameSync(temp, target);
  } catch (error) {
    log('usage', `could not write ${target}: ${String(error)}`);
  }
}

/**
 * Fetches the per-model weekly limits every five minutes while `shouldPoll` says a CLI is running,
 * and calls `onUpdate` after each write. Claude Code's status line payload carries only the
 * account-wide week, so this is the only source for Fable's own bucket — see README.local.md.
 */
export function startModelLimitsPoll(
  shouldPoll: () => boolean,
  onUpdate: () => void
): { dispose(): void } {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running || !shouldPoll()) return;
    if (Date.now() - lastFetchedAt() < MODEL_LIMITS_FRESH_MS) {
      // Another window fetched recently; its file is as good as ours.
      onUpdate();
      return;
    }
    running = true;
    try {
      const rows = await fetchModelWeekly();
      if (rows) {
        writeModelLimits(rows);
        onUpdate();
      }
    } finally {
      running = false;
    }
  };

  // The first tabs spawn a moment after activation; a few seconds later there is one to poll for.
  const first = setTimeout(() => void tick(), 5000);
  const timer = setInterval(() => void tick(), MODEL_LIMITS_POLL_MS);
  first.unref();
  timer.unref();
  return {
    dispose() {
      clearTimeout(first);
      clearInterval(timer);
    }
  };
}
