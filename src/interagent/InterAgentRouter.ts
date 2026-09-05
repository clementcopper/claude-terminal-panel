import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getInterAgentDir } from '../ptyManager';
import { log } from '../log';

const POLLING_INTERVAL_MS = 300;
const MAX_PRESENCE_AGE_MS = 5 * 60 * 1000;
const MAX_JSONL_SIZE = 1_048_576;
const MAX_JSONL_LINES = 10_000;
const MAX_ROTATIONS = 3;

interface PresenceEntry {
  engine: string;
  cwd: string;
  cols: number;
  rows: number;
  ts: number;
}

interface InterAgentMessage {
  from?: string;
  to: string;
  kind: 'text' | 'control';
  payload: string | object;
  msgId?: string;
  seq?: number;
  ts?: number;
  v?: number;
  chunk?: {
    id: string;
    index: number;
    total: number;
    data: string;
  };
}

/**
 * What the router needs from the panel: which tabs live in this window, and how to put a
 * message into one of them. The PTYs stay with `PtyManager` — the router never owns a process.
 */
export interface RouterHost {
  isLocalTab: (tabId: string) => boolean;
  deliver: (tabId: string, kind: 'text' | 'control', text: string) => void;
}

export class InterAgentRouter {
  private inboxWatcher: fs.FSWatcher | null = null;
  private pollingInterval: NodeJS.Timeout | null = null;
  /** Byte offset up to which each inbox file has been delivered — bytes, because the file is
   *  appended in bytes and a non-ASCII character would otherwise move the mark backwards. */
  private readonly filePositions = new Map<string, number>();
  /** Lines delivered per inbox file since this window opened; feeds the rotation check. */
  private readonly lineCounts = new Map<string, number>();
  private readonly seenMsgIds = new Map<string, number>(); // msgId -> timestamp
  private disposed = false;
  private readonly inboxDir: string;
  private readonly outboxDir: string;
  private readonly presenceFile: string;

  constructor(private readonly host: RouterHost) {
    const dir = getInterAgentDir();
    this.inboxDir = path.join(dir, 'inbox');
    this.outboxDir = path.join(dir, 'outbox');
    this.presenceFile = path.join(dir, 'presence.json');
    this.setupDirectories();
    this.start();
  }

  private setupDirectories(): void {
    for (const dir of [this.inboxDir, this.outboxDir]) {
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      } catch (error) {
        // Runs inside activate(): a read-only or full tmp dir must not take the panel down.
        log('interagent', `cannot create ${dir}: ${String(error)}`);
      }
    }
  }

  private start(): void {
    const pattern = /^(.+)\.to\.(.+)\.jsonl$/;

    // Everything already on disk is history: another window wrote it, or this one did before
    // the reload. Start each file at its current end, or every tab would be handed the whole
    // backlog as a paste the moment the window opens.
    try {
      for (const filename of fs.readdirSync(this.inboxDir)) {
        if (!pattern.test(filename)) continue;
        try {
          this.filePositions.set(filename, fs.statSync(path.join(this.inboxDir, filename)).size);
        } catch {
          // gone between readdir and stat — nothing to skip then
        }
      }
    } catch {
      // no inbox yet
    }

    try {
      this.inboxWatcher = fs.watch(this.inboxDir, (event, filename) => {
        if (event === 'change' && filename && pattern.test(filename)) {
          this.readNewLines(filename);
        }
      });
      // Without a listener an error on the watcher (directory removed, descriptor limit) is an
      // uncaught exception in the extension host. The poll keeps working without it.
      this.inboxWatcher.on('error', (error) => {
        log('interagent', `inbox watcher failed, polling only: ${String(error)}`);
        this.inboxWatcher?.close();
        this.inboxWatcher = null;
      });
    } catch {
      // watch may fail on some FS; polling fallback handles it
    }

    this.pollingInterval = setInterval(() => {
      if (this.disposed) return;
      try {
        const files = fs.readdirSync(this.inboxDir);
        for (const filename of files) {
          if (pattern.test(filename)) {
            this.readNewLines(filename);
          }
        }
      } catch {
        // ignore
      }
    }, POLLING_INTERVAL_MS);
    // A poll must never be what keeps the host alive.
    this.pollingInterval.unref();
  }

  private readNewLines(filename: string): void {
    const filepath = path.join(this.inboxDir, filename);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(filepath);
      if (!stat.isFile()) return;
      if (stat.uid !== os.userInfo().uid) return;
    } catch {
      return;
    }

    const match = filename.match(/^(.+)\.to\.(.+)\.jsonl$/);
    if (!match) return;
    const [, from, to] = match;

    let lastPos = this.filePositions.get(filename) ?? 0;
    if (stat.size < lastPos) {
      // Rotated or truncated by another window: start over at the top.
      lastPos = 0;
    }
    if (stat.size === lastPos) return;

    // Only the appended bytes, and only up to the last complete line: a writer may be halfway
    // through a line, and half a message must neither be parsed nor skipped.
    let chunk: Buffer;
    try {
      const fd = fs.openSync(filepath, 'r');
      try {
        chunk = Buffer.alloc(stat.size - lastPos);
        const read = fs.readSync(fd, chunk, 0, chunk.length, lastPos);
        chunk = chunk.subarray(0, read);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }
    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline < 0) return;
    const complete = chunk.subarray(0, lastNewline + 1);
    this.filePositions.set(filename, lastPos + complete.length);

    const lines = complete.toString('utf8').split('\n');
    this.lineCounts.set(filename, (this.lineCounts.get(filename) ?? 0) + lines.length - 1);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as InterAgentMessage;
        if (msg.to !== to) continue; // sanity check
        this.deliverMessage(from, to, msg);
      } catch {
        // ignore malformed lines
      }
    }

    // File rotation check
    this.maybeRotateFile(filename, filepath);
  }

  private deliverMessage(from: string, to: string, msg: InterAgentMessage): void {
    // `from` always comes from the filename, never from the body: each `<from>.to.<to>.jsonl`
    // has exactly one writer, so the name is the only sender claim that cannot be forged.
    // A body that says otherwise is ignored rather than rejected — forward compatibility.

    // Message ID deduplication
    if (msg.msgId) {
      const now = Date.now();
      const lastSeen = this.seenMsgIds.get(msg.msgId);
      if (lastSeen && now - lastSeen < MAX_PRESENCE_AGE_MS) {
        return; // duplicate
      }
      this.seenMsgIds.set(msg.msgId, now);
      // Cleanup old entries
      if (this.seenMsgIds.size > 1000) {
        const cutoff = now - MAX_PRESENCE_AGE_MS;
        for (const [id, ts] of this.seenMsgIds.entries()) {
          if (ts < cutoff) this.seenMsgIds.delete(id);
        }
      }
    }

    // Handle broadcast
    if (msg.to === 'all') {
      // The sender's own window fans out, exactly once. Every window watches this directory,
      // so without that check each of them would append its own copy per recipient.
      if (!this.host.isLocalTab(from)) return;
      const presence = this.readPresence();
      for (const recipient of Object.keys(presence)) {
        if (recipient === from) continue;
        // A fresh `to` and a per-recipient `msgId`: the fan-out copies come back through this
        // same reader, and with the sender's id they would all be swallowed as duplicates of
        // the broadcast line that produced them.
        this.writeToInbox(from, recipient, {
          ...msg,
          from,
          to: recipient,
          msgId: msg.msgId ? `${msg.msgId}#${recipient}` : undefined
        });
      }
      return;
    }

    // Only this window's tabs. The tmp directory is shared across windows on purpose, so a
    // message for a tab elsewhere is that window's router's job, not ours.
    if (!this.host.isLocalTab(to)) return;

    const text = typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload);
    this.host.deliver(to, msg.kind === 'control' ? 'control' : 'text', text);
  }

  private writeToInbox(from: string, to: string, msg: InterAgentMessage): void {
    const filename = `${from}.to.${to}.jsonl`;
    const filepath = path.join(this.inboxDir, filename);
    const line = JSON.stringify(msg) + '\n';
    try {
      fs.appendFileSync(filepath, line, { mode: 0o600 });
    } catch {
      // ignore
    }
  }

  private readPresence(): Record<string, PresenceEntry> {
    try {
      const content = fs.readFileSync(this.presenceFile, 'utf8');
      return JSON.parse(content) as Record<string, PresenceEntry>;
    } catch {
      return {};
    }
  }

  private writePresence(presence: Record<string, PresenceEntry>): void {
    const tmp = `${this.presenceFile}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(presence), { mode: 0o600 });
      fs.renameSync(tmp, this.presenceFile);
    } catch (error) {
      // Called mid-teardown of a tab: a failed write is a log line, not an aborted close.
      log('interagent', `cannot write presence: ${String(error)}`);
    }
  }

  /** Called right after a tab's PTY is spawned. */
  registerPresence(tabId: string, entry: PresenceEntry): void {
    const presence = this.readPresence();
    presence[tabId] = { ...entry, ts: Date.now() };
    this.writePresence(presence);
  }

  /** Called when a tab closes. */
  unregisterPresence(tabId: string): void {
    const presence = this.readPresence();
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete presence[tabId];
    this.writePresence(presence);
  }

  private maybeRotateFile(filename: string, filepath: string): void {
    try {
      const stat = fs.statSync(filepath);
      // Lines are counted as they are delivered rather than by re-reading the file: this runs
      // after every poll, 3.3 times a second, for every sender/recipient pair.
      if (stat.size < MAX_JSONL_SIZE && (this.lineCounts.get(filename) ?? 0) < MAX_JSONL_LINES) {
        return;
      }
      // Rotate
      for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
        const src = `${filepath}.${String(i)}`;
        const dst = `${filepath}.${String(i + 1)}`;
        try {
          fs.renameSync(src, dst);
        } catch {
          // ignore
        }
      }
      fs.renameSync(filepath, `${filepath}.1`);
      this.filePositions.set(filename, 0);
      this.lineCounts.set(filename, 0);
    } catch {
      // ignore
    }
  }

  dispose(): void {
    this.disposed = true;
    this.inboxWatcher?.close();
    this.inboxWatcher = null;
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    // Cleanup old files for tabs that no longer exist
    this.cleanupOrphanFiles();
  }

  private cleanupOrphanFiles(): void {
    const presence = this.readPresence();
    const liveTabs = new Set(Object.keys(presence));
    try {
      const files = fs.readdirSync(this.inboxDir);
      for (const file of files) {
        const match = file.match(/^(.+)\.to\.(.+)\.jsonl$/);
        if (match) {
          const [, from, to] = match;
          if (!liveTabs.has(from) && !liveTabs.has(to)) {
            try {
              fs.unlinkSync(path.join(this.inboxDir, file));
            } catch {
              // ignore
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }
}
