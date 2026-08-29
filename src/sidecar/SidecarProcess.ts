import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { IPty } from 'node-pty';
import type { SidecarMessage } from './ipc';

interface InterAgentMessage {
  from?: string;
  to: string;
  kind: 'text' | 'control';
  payload: string | object;
  msgId?: string;
  seq?: number;
  ts?: number;
  v?: number;
}

const POLLING_INTERVAL_MS = 300;

interface SidecarOptions {
  tabId: string;
  engine: 'claude' | 'opencode';
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
  interagentDir: string;
  onOutput: (data: string) => void;
  onExit: (code: number | null, signal: number | null) => void;
  onError: (message: string) => void;
  onReady: () => void;
}

interface PresenceEntry {
  engine: string;
  cwd: string;
  cols: number;
  rows: number;
  ts: number;
}

export class SidecarProcess {
  private pty: IPty | null = null;
  private inboxWatcher: fs.FSWatcher | null = null;
  private pollingInterval: NodeJS.Timeout | null = null;
  private readonly filePositions = new Map<string, number>();
  private disposed = false;
  private readonly tabId: string;
  private readonly inboxDir: string;
  private readonly outboxDir: string;
  private readonly presenceFile: string;
  private readonly options: SidecarOptions;

  constructor(options: SidecarOptions) {
    this.tabId = options.tabId;
    this.options = options;
    this.inboxDir = path.join(options.interagentDir, 'inbox');
    this.outboxDir = path.join(options.interagentDir, 'outbox');
    this.presenceFile = path.join(options.interagentDir, 'presence.json');
    this.setupDirectories();
    this.setupPty();
    this.setupInboxWatch();
    this.registerPresence();
    this.reportReady();
  }

  private setupDirectories(): void {
    for (const dir of [this.inboxDir, this.outboxDir]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  private setupPty(): void {
    const nodePty = require('node-pty') as {
      spawn: (cmd: string, args: string[], opts: object) => IPty;
    };
    this.pty = nodePty.spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      cols: this.options.cols,
      rows: this.options.rows
    });

    this.pty.onData((data: string) => {
      if (!this.disposed) {
        this.options.onOutput(data);
      }
    });

    this.pty.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      if (!this.disposed) {
        this.options.onExit(exitCode, signal ?? null);
      }
    });
  }

  private setupInboxWatch(): void {
    const pattern = new RegExp(`^.+\\.to\\.${this.escapeRegExp(this.tabId)}\\.jsonl$`);

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
      const msg = this.parseInterAgentMessage(line);
      if (!msg || msg.to !== this.tabId) continue;
      this.deliverToPty(msg.kind, msg.payload);
    }
  }

  private parseInterAgentMessage(line: string): InterAgentMessage | null {
    try {
      return JSON.parse(line) as InterAgentMessage;
    } catch {
      return null;
    }
  }

  private deliverToPty(kind: string, payload: string | object): void {
    if (!this.pty || this.disposed) return;

    if (kind === 'text') {
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
      this.pty.write(this.bracketedPaste(text));
    } else if (kind === 'control') {
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
      this.pty.write(text);
    }
  }

  private bracketedPaste(text: string): string {
    return `\x1b[200~${text}\x1b[201~`;
  }

  private registerPresence(): void {
    const presence = this.readPresence();
    presence[this.tabId] = {
      engine: this.options.engine,
      cwd: this.options.cwd,
      cols: this.options.cols,
      rows: this.options.rows,
      ts: Date.now()
    };
    this.writePresence(presence);
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

  private prunePresence(): void {
    const presence = this.readPresence();
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete presence[this.tabId];
    this.writePresence(presence);
  }

  private reportReady(): void {
    // In-process: the extension host requires this module, so there is no IPC
    // child to notify. Fire the callback directly so presence is registered.
    this.options.onReady();
  }

  private escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  onExtensionMessage(msg: SidecarMessage): void {
    if (this.disposed) return;

    switch (msg.type) {
      case 'deliver':
        this.deliverToPty(msg.kind, msg.payload);
        break;
      case 'resize':
        this.pty?.resize(msg.cols, msg.rows);
        break;
      case 'kill':
        this.kill();
        break;
    }
  }

  kill(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.inboxWatcher?.close();
    this.inboxWatcher = null;

    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    this.prunePresence();

    if (this.pty) {
      this.pty.kill();
      this.pty = null;
    }
  }

  dispose(): void {
    this.kill();
    this.cleanupFiles();
  }

  private cleanupFiles(): void {
    const pattern = new RegExp(`^.+\\.to\\.${this.escapeRegExp(this.tabId)}\\.jsonl$`);
    try {
      const files = fs.readdirSync(this.inboxDir);
      for (const file of files) {
        if (pattern.test(file)) {
          fs.unlinkSync(path.join(this.inboxDir, file));
        }
      }
    } catch {
      // ignore
    }
  }
}
