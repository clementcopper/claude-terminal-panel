import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ShellRun } from './types';

/**
 * The process monitor (Daniel, 2026-11-13, `Sessions/Fortschritt-Auftrag.md`): every Bash call
 * Claude runs in a tab, with the tail of its output.
 *
 * The `panel-bridge` mod lists the calls in `<tab id>.live.json` under `shells`; Claude Code
 * itself writes each call's output, stdout and stderr interleaved, to
 * `<tmp>/claude-<uid>/<project>/<session id>/tasks/<task id>.output` and appends
 * `[exited with code N]` when a background call ends (measured with Claude Code 2.1.323). That
 * path is Claude Code's internal layout, not a contract: a call whose file cannot be found shows
 * as unreadable rather than empty.
 *
 * A background call names its task id; a foreground one does not, so it takes the oldest
 * unclaimed `.output` file born after it started. A foreground call leaves the list when it ends;
 * a background one stays, finished, until its chip is dismissed.
 */

/** How often running calls' files are read. */
const POLL_MS = 500;
/** Lines the chip shows; the host sends no more than that. */
export const SHELL_LINES = 8;
/** Bytes kept per call for cutting lines; a progress bar redrawn with `\r` stays inside it. */
const TAIL_BYTES = 16 * 1024;
/** One line is cut here; the chip cuts again at its width. */
const LINE_MAX = 400;
/** A foreground file born this long before its call's recorded start still counts as its own. */
const BIRTH_SLACK_MS = 1500;
/** How long a call may go without a file before its chip says the output is unreadable. */
const UNREADABLE_AFTER_MS = 5000;
const EXIT_MARK = /\n*\[exited with code (-?\d+)\]\s*$/;
/** Every escape sequence but colour (SGR): cursor moves, OSC titles, mode switches. */
const NON_SGR =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-9;?]*[A-Za-ln-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78]/g;

/** One entry of the mod's `shells` list. */
export interface ShellEntry {
  key: string;
  command: string;
  description?: string;
  startedAt: number;
  sessionId?: string;
  background: boolean;
  taskId?: string;
}

interface Track {
  entry: ShellEntry;
  file?: string;
  offset: number;
  tail: string;
  exitCode?: number;
  endedAt?: number;
  gone: boolean;
}

/** The mod's list, from the raw live file; anything malformed is skipped, never thrown. */
export function parseShells(raw: string): ShellEntry[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const list = (value as { shells?: unknown }).shells;
  if (!Array.isArray(list)) return [];
  const shells: ShellEntry[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const v = item as Record<string, unknown>;
    if (typeof v.key !== 'string' || typeof v.startedAt !== 'number') continue;
    shells.push({
      key: v.key,
      command: typeof v.command === 'string' ? v.command : '',
      description: typeof v.description === 'string' ? v.description : undefined,
      startedAt: v.startedAt,
      sessionId: typeof v.sessionId === 'string' ? v.sessionId : undefined,
      background: v.background === true,
      taskId: typeof v.taskId === 'string' && /^[\w-]+$/.test(v.taskId) ? v.taskId : undefined
    });
  }
  return shells;
}

/**
 * The last lines of a tail: `\r\n` as one break, a bare `\r` (a progress bar redrawn in place)
 * keeps what was written after it, colour codes stay and every other escape goes.
 */
export function tailLines(text: string, count = SHELL_LINES): string[] {
  const lines = text
    .replace(/\r\n/g, '\n')
    .replace(NON_SGR, '')
    .split('\n')
    .map((line) => {
      const cut = line.lastIndexOf('\r');
      const shown = cut >= 0 ? line.slice(cut + 1) : line;
      return shown.length > LINE_MAX ? shown.slice(0, LINE_MAX) : shown;
    });
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop();
  return lines.slice(-count);
}

export class ShellWatcher {
  private readonly tracks = new Map<string, Map<string, Track>>();
  private readonly dismissed = new Map<string, Set<string>>();
  private readonly sent = new Map<string, string>();
  private readonly taskDirs = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(
    private readonly onShells: (terminalId: string, shells: ShellRun[]) => void,
    /** Where Claude Code keeps `claude-<uid>`; tests point it elsewhere. */
    private readonly roots: string[] = ShellWatcher.defaultRoots()
  ) {}

  private static defaultRoots(): string[] {
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (uid === undefined) return [];
    const bases = [process.env.CLAUDE_CODE_TMPDIR, '/tmp', '/private/tmp', os.tmpdir()];
    return [
      ...new Set(
        bases.filter((b): b is string => !!b).map((b) => path.join(b, `claude-${String(uid)}`))
      )
    ];
  }

  /** Every live-file read of a tab: the mod's current list of calls. */
  update(terminalId: string, liveRaw: string | undefined): void {
    if (this.disposed || liveRaw === undefined) return;
    const entries = parseShells(liveRaw);
    if (!entries) return; // half-written; the next write wins
    const tracks = this.tracks.get(terminalId) ?? new Map<string, Track>();
    const dismissed = this.dismissed.get(terminalId);
    const listed = new Set<string>();
    for (const entry of entries) {
      listed.add(entry.key);
      if (dismissed?.has(entry.key)) continue;
      const track = tracks.get(entry.key);
      if (!track) {
        tracks.set(entry.key, { entry, offset: 0, tail: '', gone: false });
      } else {
        if (entry.taskId && entry.taskId !== track.entry.taskId) {
          // A background call learned its task id after a foreground guess: read its own file
          track.file = undefined;
          track.offset = 0;
          track.tail = '';
        }
        track.entry = entry;
      }
    }
    for (const [key, track] of tracks) {
      if (listed.has(key)) continue;
      // A foreground call ended; a background one the mod no longer keeps is past its bound
      tracks.delete(key);
      void track;
    }
    for (const key of dismissed ?? []) {
      if (!listed.has(key)) dismissed?.delete(key);
    }
    this.tracks.set(terminalId, tracks);
    this.poll(terminalId);
    this.schedule();
  }

  get(terminalId: string): ShellRun[] {
    return [...(this.tracks.get(terminalId)?.values() ?? [])].map((track) => this.run(track));
  }

  /** The × on a finished chip; it stays gone while the mod still lists the call. */
  dismiss(terminalId: string, key: string): void {
    const dismissed = this.dismissed.get(terminalId) ?? new Set<string>();
    dismissed.add(key);
    this.dismissed.set(terminalId, dismissed);
    this.tracks.get(terminalId)?.delete(key);
    this.emit(terminalId);
  }

  removeTerminal(terminalId: string): void {
    this.tracks.delete(terminalId);
    this.dismissed.delete(terminalId);
    this.sent.delete(terminalId);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    const running = [...this.tracks.values()].some((tracks) =>
      [...tracks.values()].some((track) => track.exitCode === undefined && !track.gone)
    );
    if (running && !this.timer) {
      this.timer = setInterval(() => {
        for (const terminalId of this.tracks.keys()) this.poll(terminalId);
        this.schedule();
      }, POLL_MS);
    } else if (!running && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private poll(terminalId: string): void {
    const tracks = this.tracks.get(terminalId);
    if (!tracks) return;
    // Oldest first, so two foreground calls take their files in the order they started
    const ordered = [...tracks.values()].sort((a, b) => a.entry.startedAt - b.entry.startedAt);
    for (const track of ordered) {
      if (track.exitCode !== undefined || track.gone) continue;
      if (!track.file) track.file = this.locate(track);
      if (track.file) this.read(track);
    }
    this.emit(terminalId);
  }

  private emit(terminalId: string): void {
    const shells = this.get(terminalId);
    const text = JSON.stringify(shells.map(({ startedAt: _s, ...rest }) => rest));
    if (this.sent.get(terminalId) === text) return;
    this.sent.set(terminalId, text);
    this.onShells(terminalId, shells);
  }

  private run(track: Track): ShellRun {
    const { entry } = track;
    const unreadable =
      !track.file && !track.gone && Date.now() - entry.startedAt > UNREADABLE_AFTER_MS;
    return {
      key: entry.key,
      command: entry.command,
      description: entry.description,
      startedAt: entry.startedAt,
      background: entry.background,
      state:
        track.exitCode === undefined
          ? track.gone
            ? 'done'
            : 'running'
          : track.exitCode === 0
            ? 'done'
            : 'failed',
      exitCode: track.exitCode,
      endedAt: track.endedAt,
      lines: tailLines(track.tail),
      readable: !unreadable
    };
  }

  /** The folder Claude Code writes this session's output files to, found once per session. */
  private taskDir(sessionId: string | undefined): string | undefined {
    if (!sessionId || !/^[\w-]+$/.test(sessionId)) return undefined;
    const known = this.taskDirs.get(sessionId);
    if (known) return known;
    for (const root of this.roots) {
      let projects: string[];
      try {
        projects = fs.readdirSync(root);
      } catch {
        continue;
      }
      for (const project of projects) {
        const dir = path.join(root, project, sessionId, 'tasks');
        if (fs.existsSync(dir)) {
          this.taskDirs.set(sessionId, dir);
          return dir;
        }
      }
    }
    return undefined;
  }

  private locate(track: Track): string | undefined {
    const dir = this.taskDir(track.entry.sessionId);
    if (!dir) return undefined;
    if (track.entry.taskId) return path.join(dir, `${track.entry.taskId}.output`);
    // A foreground call: the oldest file born since it started that no other call holds
    const claimed = new Set<string>();
    for (const tracks of this.tracks.values()) {
      for (const other of tracks.values()) {
        if (other.file) claimed.add(other.file);
        if (other.entry.taskId) claimed.add(path.join(dir, `${other.entry.taskId}.output`));
      }
    }
    let best: { file: string; born: number } | undefined;
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return undefined;
    }
    for (const name of names) {
      if (!name.endsWith('.output')) continue;
      const file = path.join(dir, name);
      if (claimed.has(file)) continue;
      let born: number;
      try {
        const stat = fs.statSync(file);
        born = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs;
      } catch {
        continue;
      }
      if (born < track.entry.startedAt - BIRTH_SLACK_MS) continue;
      if (!best || born < best.born) best = { file, born };
    }
    return best?.file;
  }

  private read(track: Track): void {
    const file = track.file;
    if (!file) return;
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      // Claude Code deletes a foreground call's file when it ends; a background file that goes
      // keeps what was read and ends the chip without an exit code
      if (track.entry.background) {
        track.gone = true;
        track.endedAt = Date.now();
      }
      return;
    }
    if (size < track.offset) {
      track.offset = 0;
      track.tail = '';
    }
    if (size === track.offset) return;
    const start = Math.max(track.offset, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, 'r');
      fs.readSync(fd, buffer, 0, buffer.length, start);
    } catch {
      return;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    // Offsets are bytes (`.claude/rules/host.md`); the tail is text, cut by characters
    const skipped = start > track.offset;
    track.offset = size;
    const fresh = buffer.toString('utf8');
    track.tail = (skipped ? fresh : track.tail + fresh).slice(-TAIL_BYTES);
    const exit = EXIT_MARK.exec(track.tail);
    if (exit && track.entry.background) {
      track.exitCode = Number(exit[1]);
      track.endedAt = Date.now();
      track.tail = track.tail.slice(0, exit.index);
    }
  }
}
