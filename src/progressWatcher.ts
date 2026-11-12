import * as fs from 'fs';
import * as path from 'path';
import { getStatusLineDir } from './statusLineWatcher';
import type { ProgressItem, ProgressList } from './types';

/**
 * Reads the progress lists programs in a tab write — `README.local.md` § Progress lists is the
 * contract. One file per list at `<status dir>/progress/<tab id>/<list id>.json`; a subfolder
 * because the status line watcher reads every `.json` directly in the window folder as a tab.
 *
 * The files come from foreign processes and are as untrusted as terminal output: every string is
 * cut, the item count is capped, and nothing here opens a path.
 */

const LIST_ID = /^[a-z0-9-]{1,40}$/;
const MAX_ITEMS = 200;
const MAX_TITLE = 120;
const MAX_NOTE = 500;
const MAX_PATH = 1024;
const LIST_STATES = new Set(['running', 'done', 'failed']);
const ITEM_STATES = new Set(['pending', 'running', 'ok', 'failed', 'blocked', 'info']);
/** How often a running list's process is checked for life; only while one is running. */
const PID_CHECK_MS = 5_000;
const DEBOUNCE_MS = 50;

export function getProgressRoot(): string {
  return path.join(getStatusLineDir(), 'progress');
}

/** A list as written, plus the pid the reader needs and the webview does not. */
interface StoredList {
  list: ProgressList;
  pid?: number;
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Parses one file. `fileId` is the name without `.json`; a list whose `id` disagrees with it is
 * dropped, so two files can never claim the same chip. Returns undefined for anything that is not
 * a v1 list — including a half-written file, which then leaves the previous one standing.
 */
export function parseProgressList(
  raw: string,
  fileId: string
): { list: ProgressList; pid?: number } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const value = parsed as Record<string, unknown>;
  if (value.v !== 1 || value.id !== fileId || !LIST_ID.test(fileId)) return undefined;
  if (typeof value.state !== 'string' || !LIST_STATES.has(value.state)) return undefined;
  if (!Array.isArray(value.items)) return undefined;

  const items: ProgressItem[] = [];
  for (const entry of value.items.slice(0, MAX_ITEMS)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const state = item.state;
    const label = text(item.label, MAX_TITLE) ?? text(item.id, MAX_TITLE);
    if (typeof state !== 'string' || !ITEM_STATES.has(state) || label === undefined) continue;
    items.push({
      id: text(item.id, MAX_TITLE) ?? label,
      label,
      state: state as ProgressItem['state'],
      seconds: finite(item.seconds),
      startedAt: finite(item.startedAt),
      note: text(item.note, MAX_NOTE),
      log: text(item.log, MAX_PATH)
    });
  }

  const pausedRaw =
    typeof value.paused === 'object' && value.paused !== null
      ? (value.paused as Record<string, unknown>)
      : undefined;
  const pausedSince = pausedRaw ? finite(pausedRaw.since) : undefined;
  const now = Date.now();
  return {
    list: {
      id: fileId,
      title: text(value.title, MAX_TITLE) ?? fileId,
      state: value.state as ProgressList['state'],
      startedAt: finite(value.startedAt) ?? now,
      updatedAt: finite(value.updatedAt) ?? now,
      expectedSeconds: finite(value.expectedSeconds),
      paused:
        pausedRaw && pausedSince !== undefined
          ? { reason: text(pausedRaw.reason, MAX_TITLE) ?? '', since: pausedSince }
          : undefined,
      detail: text(value.detail, MAX_PATH),
      items
    },
    pid: finite(value.pid)
  };
}

/** `kill(pid, 0)` sends nothing; EPERM means the process exists but belongs to someone else. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class ProgressWatcher {
  private readonly root: string;
  /** Tab id → list id → the last list that parsed. */
  private readonly lists = new Map<string, Map<string, StoredList>>();
  /** Tab id → list id → `startedAt` of the run whose chip the × hid; a new run shows again. */
  private readonly dismissed = new Map<string, Map<string, number>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private watcher: fs.FSWatcher | undefined;
  private pidTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(
    private readonly onLists: (terminalId: string, lists: ProgressList[]) => void,
    root: string = getProgressRoot()
  ) {
    this.root = root;
    try {
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
      // Recursive: the lists sit one folder down, one per tab, and a writer creates that folder
      // itself. Native on macOS and Windows.
      this.watcher = fs.watch(this.root, { recursive: true }, (_event, filename) => {
        if (filename) this.schedule(filename);
      });
      this.watcher.on('error', () => {
        // The folder went away (a tmp cleaner); the lists already shown stay as they are
      });
    } catch {
      this.watcher = undefined;
    }
  }

  /** What a rebuilt webview gets for one tab. */
  get(terminalId: string): ProgressList[] {
    return this.current(terminalId);
  }

  /**
   * The × on a finished chip hides that run. The file stays until the tab closes: programs read
   * it from outside the panel (`kuza status` shows the last check), and the contract promises it.
   */
  dismiss(terminalId: string, listId: string): void {
    if (!LIST_ID.test(listId)) return;
    const stored = this.lists.get(terminalId)?.get(listId);
    if (!stored) return;
    const byId = this.dismissed.get(terminalId) ?? new Map<string, number>();
    byId.set(listId, stored.list.startedAt);
    this.dismissed.set(terminalId, byId);
    this.emit(terminalId);
  }

  /** The tab closed: its lists and their folder go with it. */
  removeTerminal(terminalId: string): void {
    this.lists.delete(terminalId);
    this.dismissed.delete(terminalId);
    for (const [key, timer] of this.timers) {
      if (key.startsWith(`${terminalId}/`)) {
        clearTimeout(timer);
        this.timers.delete(key);
      }
    }
    if (!terminalId || terminalId.includes('/') || terminalId.includes('..')) return;
    try {
      fs.rmSync(path.join(this.root, terminalId), { recursive: true, force: true });
    } catch {
      // Nothing to remove
    }
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.close();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.pidTimer) clearInterval(this.pidTimer);
    this.pidTimer = undefined;
  }

  /** A write fires several events (temp file, rename); one read per file per burst. */
  private schedule(relative: string): void {
    if (this.disposed) return;
    const parts = relative.split(/[\\/]/);
    if (parts.length !== 2 || !parts[1].endsWith('.json')) return;
    const key = `${parts[0]}/${parts[1]}`;
    const pending = this.timers.get(key);
    if (pending) clearTimeout(pending);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.read(parts[0], parts[1].slice(0, -'.json'.length));
      }, DEBOUNCE_MS)
    );
  }

  private read(terminalId: string, listId: string): void {
    if (this.disposed) return;
    let raw: string | undefined;
    try {
      raw = fs.readFileSync(path.join(this.root, terminalId, `${listId}.json`), 'utf8');
    } catch {
      raw = undefined;
    }
    const byId = this.lists.get(terminalId) ?? new Map<string, StoredList>();
    if (raw === undefined) {
      // Deleted: by the writer starting over, or by hand
      if (!byId.delete(listId)) return;
    } else {
      const parsed = parseProgressList(raw, listId);
      if (!parsed) return;
      byId.set(listId, parsed);
    }
    this.lists.set(terminalId, byId);
    this.emit(terminalId);
  }

  /** Lists oldest first, with a running list whose process died reported as cancelled. */
  private current(terminalId: string): ProgressList[] {
    const byId = this.lists.get(terminalId);
    if (!byId) return [];
    const hidden = this.dismissed.get(terminalId);
    return [...byId.values()]
      .filter(({ list }) => hidden?.get(list.id) !== list.startedAt)
      .map(({ list, pid }) =>
        list.state === 'running' && pid !== undefined && !isAlive(pid)
          ? { ...list, state: 'cancelled' as const, paused: undefined }
          : list
      )
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  private emit(terminalId: string): void {
    const lists = this.current(terminalId);
    this.onLists(terminalId, lists);
    this.updatePidTimer();
  }

  /**
   * A process killed by Ctrl-C or a crash writes nothing more, so its list would say "running"
   * for ever. While any list still claims to run, look at the pids every few seconds and send the
   * tab again once one has died.
   */
  private updatePidTimer(): void {
    const running = [...this.lists.values()].some((byId) =>
      [...byId.values()].some(
        ({ list, pid }) => list.state === 'running' && pid !== undefined && isAlive(pid)
      )
    );
    if (running && !this.pidTimer && !this.disposed) {
      this.pidTimer = setInterval(() => {
        for (const [terminalId, byId] of this.lists) {
          const died = [...byId.values()].some(
            ({ list, pid }) => list.state === 'running' && pid !== undefined && !isAlive(pid)
          );
          if (died) {
            // Store the verdict so the next tick does not send it again
            for (const [listId, stored] of byId) {
              if (
                stored.list.state === 'running' &&
                stored.pid !== undefined &&
                !isAlive(stored.pid)
              ) {
                byId.set(listId, {
                  list: { ...stored.list, state: 'cancelled', paused: undefined },
                  pid: stored.pid
                });
              }
            }
            this.onLists(terminalId, this.current(terminalId));
          }
        }
        this.updatePidTimer();
      }, PID_CHECK_MS);
    } else if (!running && this.pidTimer) {
      clearInterval(this.pidTimer);
      this.pidTimer = undefined;
    }
  }
}
