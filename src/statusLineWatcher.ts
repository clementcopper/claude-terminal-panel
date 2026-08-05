import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { StatusLineSnapshot } from './types';

/**
 * Directory the statusLine script writes its per-tab snapshots into.
 * `os.tmpdir()` is per-user on macOS (`/var/folders/…`); the script additionally
 * writes with `umask 077`.
 */
export function getStatusLineDir(): string {
  return path.join(os.tmpdir(), 'claude-terminal-panel', 'status');
}

export type StatusLineCallback = (terminalId: string, snapshot: StatusLineSnapshot | null) => void;

/**
 * Watches the status directory and reports whatever the statusLine script wrote.
 *
 * The extension host only ever sees PTY bytes, so model, token counts and rate limits
 * cannot be read from the terminal. Claude Code hands them to the configured statusLine
 * command instead, which writes them here as `<terminal id>.json`.
 */
export class StatusLineWatcher {
  private readonly dir = getStatusLineDir();
  private watcher: fs.FSWatcher | undefined;
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
  }

  private removeStaleFiles(): void {
    try {
      for (const entry of fs.readdirSync(this.dir)) {
        fs.unlinkSync(path.join(this.dir, entry));
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

    this.latest.set(terminalId, snapshot);
    this.onSnapshot(terminalId, snapshot);
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
    usedTokens,
    totalTokens,
    usedPercent,
    sessionPercent: numberOrUndefined(value.sessionPercent),
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
