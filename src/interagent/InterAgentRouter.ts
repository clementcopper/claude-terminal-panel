import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getInterAgentDir } from '../ptyManager';

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
  private readonly filePositions = new Map<string, number>();
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
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
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

    const lastPos = this.filePositions.get(filename) ?? 0;
    let content: string;
    try {
      content = fs.readFileSync(filepath, 'utf8');
    } catch {
      return;
    }

    if (content.length <= lastPos) {
      this.filePositions.set(filename, content.length);
      return;
    }

    const newContent = content.slice(lastPos);
    this.filePositions.set(filename, content.length);

    const lines = newContent.split('\n');
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
    fs.writeFileSync(tmp, JSON.stringify(presence), { mode: 0o600 });
    fs.renameSync(tmp, this.presenceFile);
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
      if (stat.size < MAX_JSONL_SIZE) {
        // Count lines approximately
        const content = fs.readFileSync(filepath, 'utf8');
        if (content.split('\n').length < MAX_JSONL_LINES) return;
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
