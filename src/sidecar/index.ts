import { SidecarProcess } from './SidecarProcess';
import { deserialize } from './ipc';

interface SpawnSidecarOptions {
  tabId: string;
  engine: 'claude' | 'opencode';
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
  interagentDir: string;
  onOutput: (tabId: string, data: string) => void;
  onExit: (tabId: string, code: number | null, signal: number | null) => void;
  onError: (tabId: string, message: string) => void;
  onReady: (tabId: string) => void;
}

let currentSidecar: SidecarProcess | null = null;

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  for (const line of chunk.split('\n')) {
    if (!line.trim()) continue;
    const msg = deserialize(line);
    if (msg && currentSidecar) {
      currentSidecar.onExtensionMessage(msg);
    }
  }
});

process.on('SIGTERM', () => {
  currentSidecar?.kill();
  process.exit(0);
});

process.on('SIGINT', () => {
  currentSidecar?.kill();
  process.exit(0);
});

export function spawnSidecar(options: SpawnSidecarOptions): SidecarProcess {
  currentSidecar = new SidecarProcess({
    tabId: options.tabId,
    engine: options.engine,
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    cols: options.cols,
    rows: options.rows,
    env: options.env,
    interagentDir: options.interagentDir,
    onOutput: (data: string) => { options.onOutput(options.tabId, data); },
    onExit: (code: number | null, signal: number | null) => { options.onExit(options.tabId, code, signal); },
    onError: (message: string) => { options.onError(options.tabId, message); },
    onReady: () => { options.onReady(options.tabId); },
  });
  return currentSidecar;
}

export function getCurrentSidecar(): SidecarProcess | null {
  return currentSidecar;
}

export { SidecarProcess } from './SidecarProcess';