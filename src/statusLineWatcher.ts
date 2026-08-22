import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import type { StatusLineSnapshot } from './types';

/**
 * Directory the statusLine script writes its per-tab snapshots into.
 * `os.tmpdir()` is per-user on macOS (`/var/folders/…`); the script additionally
 * writes with `umask 077`.
 */
export function getStatusLineDir(): string {
  return path.join(os.tmpdir(), 'claude-terminal-panel', 'status');
}

/** Shared file holding the account's rate limits, written by whichever tab last saw them. */
const LIMITS_FILE = 'limits.json';
/** Upper bound on how long a tab shows a limit another tab has already superseded. */
const LIMITS_POLL_MS = 30_000;

export type StatusLineCallback = (terminalId: string, snapshot: StatusLineSnapshot | null) => void;

/** `~` for the home directory, matching what the producers write. */
function collapseHome(dir: string): string {
  const home = os.homedir();
  if (home.length === 0) return dir;
  if (dir === home) return '~';
  return dir.startsWith(home + path.sep) ? `~${dir.slice(home.length)}` : dir;
}

/**
 * File name for the remembered snapshot. Hashed rather than escaped so a path with separators or
 * odd characters cannot escape the directory, and collapsed first so `/Users/x/p` and `~/p` are
 * the same key.
 */
function hashCwd(cwd: string): string {
  return createHash('sha1').update(collapseHome(cwd)).digest('hex').slice(0, 16);
}

/**
 * Watches the status directory and reports whatever the statusLine script wrote.
 *
 * The extension host only ever sees PTY bytes, so model, token counts and rate limits
 * cannot be read from the terminal. Claude Code hands them to the configured statusLine
 * command instead, which writes them here as `<terminal id>.json`.
 */
export class StatusLineWatcher {
  private readonly dir = getStatusLineDir();
  /**
   * Last snapshot per working directory, kept across windows. Claude Code only runs the
   * statusLine command when it renders, which is after its first output — so a fresh tab would
   * show nothing for a while. This is what fills the row in the meantime, greyed out because its
   * `updatedAt` is old.
   */
  private readonly lastDir = path.join(getStatusLineDir(), 'last');
  private watcher: fs.FSWatcher | undefined;
  /**
   * Second watcher, on `last/`. The rate limits belong to the account, so a tab that renders
   * nothing itself can still learn a fresher percentage from one that does — in this window or
   * another. `fs.watch` is not recursive, so the directory above does not report this.
   */
  private limitsWatcher: fs.FSWatcher | undefined;
  private limitsPoll: NodeJS.Timeout | undefined;
  /** Guards against re-sending the same file: `updatedAt` of what was last broadcast. */
  private lastBroadcastLimitsAt: number | undefined;
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly latest = new Map<string, StatusLineSnapshot>();
  private disposed = false;

  constructor(
    private readonly onSnapshot: StatusLineCallback,
    private readonly debounceMs = 150
  ) {
    this.start();
  }

  /** The last snapshot seen for a tab, so a webview reload can be filled in again. */
  get(terminalId: string): StatusLineSnapshot | undefined {
    return this.latest.get(terminalId);
  }

  /**
   * What a brand new tab in this directory should show until Claude renders for the first time:
   * the previous session's snapshot if there is one, otherwise just the directory.
   */
  getInitialSnapshot(cwd: string | undefined): StatusLineSnapshot | undefined {
    if (cwd === undefined) {
      return undefined;
    }

    const base: StatusLineSnapshot = this.readLastForCwd(cwd) ?? {
      // Nothing remembered for this directory — the path alone still beats an empty row, and it
      // keeps the terminal height from changing once the real values arrive.
      model: '',
      cwd: collapseHome(cwd),
      usedTokens: 0,
      totalTokens: 0,
      usedPercent: 0,
      updatedAt: 0
    };

    return this.withRememberedLimits(base);
  }

  /**
   * Fills in rate limits the snapshot does not carry. Two reasons it may not:
   *
   * - Claude Code leaves `rate_limits` out of its payload until a request has been made, so the
   *   first snapshots of a session have no Session and Week at all.
   * - A brand new tab starts from the remembered directory snapshot, which may predate them.
   *
   * The limits belong to the account rather than a directory, hence their own file. Only
   * undefined fields are filled — a live value always wins over a remembered one.
   */
  private withRememberedLimits(snapshot: StatusLineSnapshot): StatusLineSnapshot {
    const limits = this.readLimits();
    if (!limits) {
      return snapshot;
    }

    const merged = { ...snapshot };
    for (const [key, value] of Object.entries(limits) as [
      keyof StatusLineSnapshot,
      number | string | undefined
    ][]) {
      if (value !== undefined && merged[key] === undefined) {
        Object.assign(merged, { [key]: value });
      }
    }

    // A remembered "resets in 84 min" is a lie an hour later: recompute from the absolute point,
    // and drop the session values once that point has passed — the window reset, so the old
    // percentage says nothing about the new one.
    if (merged.sessionResetsAt !== undefined) {
      const minutes = Math.round((merged.sessionResetsAt * 1000 - Date.now()) / 60000);
      if (minutes <= 0) {
        delete merged.sessionPercent;
        delete merged.sessionResetsAt;
        delete merged.sessionResetsInMin;
      } else {
        merged.sessionResetsInMin = minutes;
      }
    } else {
      delete merged.sessionResetsInMin;
    }

    return merged;
  }

  /**
   * Supplies the context window size when the payload has none yet, so the bar has a scale from
   * the start. The **usage** is never taken from memory: a fresh session really is at zero, and
   * showing the previous session's tokens would be a lie rather than a placeholder.
   */
  private withRememberedWindowSize(snapshot: StatusLineSnapshot): StatusLineSnapshot {
    if (snapshot.totalTokens > 0 || snapshot.cwd === undefined) {
      return snapshot;
    }

    const remembered = this.readLastForCwd(snapshot.cwd);
    if (!remembered || remembered.totalTokens <= 0) {
      return snapshot;
    }

    const totalTokens = remembered.totalTokens;
    return {
      ...snapshot,
      totalTokens,
      usedPercent: Math.round((snapshot.usedTokens / totalTokens) * 1000) / 10
    };
  }

  private readLimits(): Partial<StatusLineSnapshot> | undefined {
    try {
      const raw = fs.readFileSync(path.join(this.lastDir, LIMITS_FILE), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) {
        return undefined;
      }
      const value = parsed as Record<string, unknown>;
      return {
        sessionPercent: numberOrUndefined(value.sessionPercent),
        sessionResetsAt: numberOrUndefined(value.sessionResetsAt),
        sessionResetsInMin: numberOrUndefined(value.sessionResetsInMin),
        weekPercent: numberOrUndefined(value.weekPercent),
        weekResetsAt: typeof value.weekResetsAt === 'string' ? value.weekResetsAt : undefined,
        updatedAt: numberOrUndefined(value.updatedAt)
      };
    } catch {
      return undefined;
    }
  }

  private rememberLimits(snapshot: StatusLineSnapshot): void {
    if (snapshot.sessionPercent === undefined && snapshot.weekPercent === undefined) {
      return;
    }
    this.writeAtomically(LIMITS_FILE, {
      sessionPercent: snapshot.sessionPercent,
      sessionResetsAt: snapshot.sessionResetsAt,
      sessionResetsInMin: snapshot.sessionResetsInMin,
      weekPercent: snapshot.weekPercent,
      weekResetsAt: snapshot.weekResetsAt,
      updatedAt: snapshot.updatedAt
    });
  }

  private readLastForCwd(cwd: string): StatusLineSnapshot | undefined {
    try {
      const raw = fs.readFileSync(path.join(this.lastDir, `${hashCwd(cwd)}.json`), 'utf8');
      return parseSnapshot(raw);
    } catch {
      return undefined;
    }
  }

  private rememberForCwd(snapshot: StatusLineSnapshot): void {
    if (snapshot.cwd === undefined || snapshot.cwd.length === 0 || snapshot.totalTokens <= 0) {
      return;
    }
    this.writeAtomically(`${hashCwd(snapshot.cwd)}.json`, snapshot);
  }

  private writeAtomically(fileName: string, payload: unknown): void {
    try {
      fs.mkdirSync(this.lastDir, { recursive: true, mode: 0o700 });
      const target = path.join(this.lastDir, fileName);
      const temp = `${target}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(payload), { mode: 0o600 });
      fs.renameSync(temp, target);
    } catch {
      // Remembering is a convenience; failing at it must not affect the live row
    }
  }

  /** Drops a tab's snapshot and its file. */
  removeTerminal(terminalId: string): void {
    this.clearTimer(terminalId);
    this.latest.delete(terminalId);
    try {
      fs.unlinkSync(path.join(this.dir, `${terminalId}.json`));
    } catch {
      // Never written, or already gone
    }
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.close();
    this.watcher = undefined;
    this.limitsWatcher?.close();
    this.limitsWatcher = undefined;
    if (this.limitsPoll) {
      clearInterval(this.limitsPoll);
      this.limitsPoll = undefined;
    }
    for (const terminalId of [...this.latest.keys()]) {
      this.removeTerminal(terminalId);
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  private start(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      console.warn('[Claude Terminal] status line directory unavailable', error);
      return;
    }

    // Leftovers from a previous window describe tabs that no longer exist.
    this.removeStaleFiles();

    try {
      this.watcher = fs.watch(this.dir, { persistent: false }, (_event, filename) => {
        if (filename) {
          this.scheduleRead(filename);
        }
      });
    } catch (error) {
      console.warn('[Claude Terminal] cannot watch the status line directory', error);
    }

    this.startLimitsWatch();
  }

  /**
   * Keeps the rate limits current in tabs that render nothing themselves. The percentage cannot be
   * recomputed the way the countdown can — it exists only in Claude's payload — but it is an
   * account-wide number, so whichever tab last saw one shares it through `last/limits.json`.
   *
   * Both a watch and a poll: the watch reacts at once, the interval is the guarantee, because
   * `fs.watch` is platform-dependent and an atomic rename can slip past it.
   */
  private startLimitsWatch(): void {
    try {
      fs.mkdirSync(this.lastDir, { recursive: true, mode: 0o700 });
      this.limitsWatcher = fs.watch(this.lastDir, { persistent: false }, (_event, filename) => {
        if (filename === LIMITS_FILE) {
          this.scheduleLimitsBroadcast();
        }
      });
    } catch (error) {
      console.warn('[Claude Terminal] cannot watch the remembered limits', error);
    }

    this.limitsPoll = setInterval(() => {
      this.broadcastLimits();
    }, LIMITS_POLL_MS);
    // Never hold the host process open for a status row
    this.limitsPoll.unref();
  }

  /** The file is written through a temp file plus rename, so one update fires several events. */
  private scheduleLimitsBroadcast(): void {
    if (this.disposed) return;

    const existing = this.debounceTimers.get(LIMITS_FILE);
    if (existing) {
      clearTimeout(existing);
    }
    this.debounceTimers.set(
      LIMITS_FILE,
      setTimeout(() => {
        this.debounceTimers.delete(LIMITS_FILE);
        this.broadcastLimits();
      }, this.debounceMs)
    );
  }

  /**
   * Hands newer limits to every tab whose own snapshot predates them. The tab's `updatedAt` stays
   * untouched: it drives the stale dimming, and its model and context really are old — only the
   * limits row, which the dimming exempts, gets the fresh numbers.
   */
  private broadcastLimits(): void {
    if (this.disposed) return;

    const limits = this.readLimits();
    const limitsAt = limits?.updatedAt;
    if (!limits || limitsAt === undefined || limitsAt === this.lastBroadcastLimitsAt) {
      return;
    }
    this.lastBroadcastLimitsAt = limitsAt;

    for (const [terminalId, snapshot] of this.latest) {
      // A tab that rendered more recently than the file already knows better
      if (limitsAt <= snapshot.updatedAt) {
        continue;
      }

      const merged: StatusLineSnapshot = {
        ...snapshot,
        sessionPercent: limits.sessionPercent,
        sessionResetsAt: limits.sessionResetsAt,
        sessionResetsInMin: limits.sessionResetsInMin,
        weekPercent: limits.weekPercent,
        weekResetsAt: limits.weekResetsAt
      };

      this.latest.set(terminalId, merged);
      this.onSnapshot(terminalId, merged);
    }
  }

  /**
   * Snapshots from a previous window describe tabs that no longer exist. The `last` directory is
   * deliberately kept — that is the memory a fresh tab starts from.
   */
  private removeStaleFiles(): void {
    try {
      for (const entry of fs.readdirSync(this.dir, { withFileTypes: true })) {
        if (entry.isFile()) {
          fs.unlinkSync(path.join(this.dir, entry.name));
        }
      }
    } catch {
      // Empty or unreadable — nothing to clean up
    }
  }

  /**
   * The script writes through a temp file plus rename, so a single update can fire several
   * events. Debouncing per file keeps that down to one read.
   */
  private scheduleRead(filename: string): void {
    if (this.disposed || !filename.endsWith('.json')) {
      return;
    }

    const terminalId = filename.slice(0, -'.json'.length);
    this.clearTimer(terminalId);
    this.debounceTimers.set(
      terminalId,
      setTimeout(() => {
        this.debounceTimers.delete(terminalId);
        this.read(terminalId);
      }, this.debounceMs)
    );
  }

  private read(terminalId: string): void {
    if (this.disposed) return;

    let raw: string;
    try {
      raw = fs.readFileSync(path.join(this.dir, `${terminalId}.json`), 'utf8');
    } catch {
      // File removed between event and read
      this.latest.delete(terminalId);
      this.onSnapshot(terminalId, null);
      return;
    }

    const snapshot = parseSnapshot(raw);
    if (!snapshot) {
      return;
    }

    // Remember first, from the live values, then hand out a snapshot topped up with whatever
    // rate limits are known — Claude omits them until the session has made a request.
    this.rememberForCwd(snapshot);
    this.rememberLimits(snapshot);

    const complete = this.withRememberedLimits(this.withRememberedWindowSize(snapshot));
    this.latest.set(terminalId, complete);
    this.onSnapshot(terminalId, complete);
  }

  private clearTimer(terminalId: string): void {
    const timer = this.debounceTimers.get(terminalId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(terminalId);
    }
  }
}

/**
 * Parses a snapshot defensively. The file is written by a shell script, so a truncated or
 * half-formatted write must not take the panel down — it is dropped and the next write wins.
 */
function parseSnapshot(raw: string): StatusLineSnapshot | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }

  const value = parsed as Record<string, unknown>;
  const usedTokens = numberOrUndefined(value.usedTokens);
  const totalTokens = numberOrUndefined(value.totalTokens);
  const usedPercent = numberOrUndefined(value.usedPercent);

  if (usedTokens === undefined || totalTokens === undefined || usedPercent === undefined) {
    return undefined;
  }

  return {
    model: typeof value.model === 'string' ? value.model : '',
    effort: typeof value.effort === 'string' ? value.effort : undefined,
    cwd: typeof value.cwd === 'string' ? value.cwd : undefined,
    usedTokens,
    totalTokens,
    usedPercent,
    sessionPercent: numberOrUndefined(value.sessionPercent),
    sessionResetsAt: numberOrUndefined(value.sessionResetsAt),
    sessionResetsInMin: numberOrUndefined(value.sessionResetsInMin),
    weekPercent: numberOrUndefined(value.weekPercent),
    weekResetsAt: typeof value.weekResetsAt === 'string' ? value.weekResetsAt : undefined,
    compacted: numberOrUndefined(value.compacted),
    compactBudget: numberOrUndefined(value.compactBudget),
    compactAuto: numberOrUndefined(value.compactAuto),
    updatedAt: numberOrUndefined(value.updatedAt) ?? 0
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
