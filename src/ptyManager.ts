import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import type { IPty, INodePty, TerminalConfig } from './types';
import { getStatusLineDir } from './statusLineWatcher';
import { log } from './log';

/**
 * Directory the inter-agent channel writes its per-tab snapshots into.
 * Mirrors the statusline pattern: per-user tmp, 0700.
 */
export function getInterAgentDir(): string {
  return path.join(os.tmpdir(), 'claude-terminal-panel', 'interagent');
}

/**
 * Single-quotes a path for a POSIX shell. Both paths involved contain spaces on macOS
 * ("Visual Studio Code.app"), and Claude Code runs the statusLine command through a shell.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Callbacks for PTY events.
 */
export interface PtyEventCallbacks {
  onData: (terminalId: string, data: string) => void;
  onExit: (terminalId: string, exitCode: number) => void;
  onError: (terminalId: string, error: string) => void;
}

/**
 * Result of selecting a working directory.
 */
export interface WorkingDirectorySelection {
  path: string;
  folderIndex: number | undefined;
}

/**
 * Manages PTY process lifecycle.
 * Extracted from ClaudeTerminalViewProvider._startTerminalForInstance().
 */
export class PtyManager {
  private nodePty: INodePty | undefined;
  private readonly ptys = new Map<string, IPty>();
  /** When each PTY was spawned, so an exit can be reported with the life it had. */
  private readonly startedAt = new Map<string, number>();

  constructor(
    private readonly callbacks: PtyEventCallbacks,
    private readonly extensionUri: vscode.Uri
  ) {}

  /**
   * Spawns a new PTY process for the given terminal ID.
   * @param cwd Optional working directory. If not provided, uses default logic.
   */
  spawn(
    terminalId: string,
    config: TerminalConfig,
    cols: number,
    rows: number,
    cwd?: string
  ): void {
    // Kill existing PTY for this terminal if any
    this.kill(terminalId);

    try {
      this.ensureNodePtyLoaded();
      // The bundled status line producer is handed over per session, so nothing in the user's
      // ~/.claude/settings.json has to change.
      const effectiveConfig = this.withStatusLineSettings(config);
      const { shell, env, cwd: defaultCwd } = this.prepareSpawnOptions(config, terminalId);
      const workingDir = cwd ?? defaultCwd;
      const pty = this.createPty(effectiveConfig, shell, cols, rows, workingDir, env);

      this.ptys.set(terminalId, pty);
      this.startedAt.set(terminalId, Date.now());
      log(
        'pty',
        `${terminalId} spawn pid ${String(pty.pid)} ${String(cols)}x${String(rows)} in ${workingDir} — ${
          effectiveConfig.directMode
            ? [effectiveConfig.command, ...effectiveConfig.args].join(' ')
            : shell
        }`
      );
      this.setupPtyEventHandlers(terminalId, pty);
      this.handleAutoRun(pty, effectiveConfig);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log('pty', `${terminalId} spawn failed: ${errorMessage}`);
      this.callbacks.onError(terminalId, errorMessage);
    }
  }

  /**
   * Prompts the user to select a workspace folder if multiple are available.
   * Returns the selected folder path and its index for color mapping.
   */
  async selectWorkingDirectory(configuredCwd = ''): Promise<WorkingDirectorySelection> {
    // A configured directory wins over the workspace, and skips the folder prompt:
    // session history lives per directory, so this keeps it stable across windows.
    const fixed = this.resolveConfiguredCwd(configuredCwd);
    if (fixed) {
      return { path: fixed, folderIndex: undefined };
    }

    const folders = vscode.workspace.workspaceFolders;

    // If no folders or only one, use default behavior (no color indexing)
    if (!folders || folders.length <= 1) {
      return {
        path: this.getWorkingDirectory(),
        folderIndex: undefined
      };
    }

    // Multiple workspace folders - let user choose
    const items = folders.map((folder, index) => ({
      label: folder.name,
      description: folder.uri.fsPath,
      folder,
      index
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select workspace folder for Claude',
      title: 'Choose Working Directory'
    });

    if (selected) {
      return {
        path: selected.folder.uri.fsPath,
        folderIndex: selected.index
      };
    }

    // User cancelled - use first folder as default
    return {
      path: folders[0].uri.fsPath,
      folderIndex: 0
    };
  }

  private ensureNodePtyLoaded(): void {
    if (!this.nodePty) {
      this.nodePty = require('node-pty') as INodePty;
    }
  }

  private prepareSpawnOptions(
    config: TerminalConfig,
    terminalId: string
  ): {
    shell: string;
    env: Record<string, string>;
    cwd: string;
  } {
    const shell = config.shell || this.getDefaultShell();
    const cwd = this.resolveConfiguredCwd(config.cwd) ?? this.getWorkingDirectory();
    const env = this.buildEnvironment(config.env, terminalId, config);
    return { shell, env, cwd };
  }

  /**
   * Resolves the `claudeTerminal.cwd` setting: expands a leading `~` and requires
   * the directory to exist. Returns undefined when unset or unusable.
   */
  private resolveConfiguredCwd(configuredCwd: string): string | undefined {
    const raw = configuredCwd.trim();
    if (!raw) {
      return undefined;
    }

    const expanded =
      raw === '~' || raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(1)) : raw;

    if (!fs.existsSync(expanded)) {
      void vscode.window.showWarningMessage(
        `Claude Terminal: claudeTerminal.cwd does not exist, falling back to the workspace folder: ${expanded}`
      );
      return undefined;
    }

    return expanded;
  }

  /**
   * Adds `--settings` with the bundled status line producer when the tab runs Claude Code.
   *
   * Additional settings for this process only: the user's own configuration stays untouched,
   * and outside the panel their status line keeps behaving exactly as before.
   */
  private withStatusLineSettings(config: TerminalConfig): TerminalConfig {
    if (!config.statusLine || config.statusLineProvider !== 'bundled') {
      return config;
    }
    // `gemini`, `aider` and friends would choke on an unknown flag
    if (path.basename(config.command).replace(/\.(exe|cmd|bat)$/i, '') !== 'claude') {
      return config;
    }

    const settings = JSON.stringify({
      statusLine: { type: 'command', command: this.getBundledStatusLineCommand() }
    });

    return { ...config, args: [...config.args, '--settings', settings] };
  }

  /**
   * How the producer is started. VS Code's own binary runs it, so no `node` on PATH is needed;
   * `ELECTRON_RUN_AS_NODE` sits in the command string rather than the PTY environment, or every
   * Electron app started from that terminal would inherit it.
   */
  private getBundledStatusLineCommand(): string {
    const script = vscode.Uri.joinPath(
      this.extensionUri,
      'resources',
      'panel-statusline.js'
    ).fsPath;
    return `ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)} ${shellQuote(script)}`;
  }

  /**
   * The user's own statusLine command, so the bundled producer can still run it for its side
   * effects — a context warning, a log, whatever it does besides printing.
   */
  private getUserStatusLineCommand(): string | undefined {
    try {
      const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      const parsed: unknown = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) {
        return undefined;
      }
      const statusLine = (parsed as { statusLine?: { type?: string; command?: string } })
        .statusLine;
      if (statusLine?.type === 'command' && typeof statusLine.command === 'string') {
        return statusLine.command;
      }
    } catch {
      // No settings file, or not readable — then there is nothing to delegate to
    }
    return undefined;
  }

  private getDefaultShell(): string {
    if (process.platform === 'win32') {
      return process.env.COMSPEC || 'cmd.exe';
    }
    return process.env.SHELL || '/bin/bash';
  }

  private getWorkingDirectory(): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const cwd = workspaceFolder || os.homedir();
    return fs.existsSync(cwd) ? cwd : os.homedir();
  }

  private buildEnvironment(
    configEnv: Record<string, string>,
    terminalId: string,
    config: TerminalConfig
  ): Record<string, string> {
    const env: Record<string, string> = {};

    // Copy process.env, filtering undefined values
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }

    // Add config env and terminal settings
    Object.assign(env, configEnv, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FORCE_COLOR: '1'
    });

    // Inter-agent channel: every PTY gets these, status line or not. OpenCode has no status
    // line, and gating them behind it would leave that tab unable to name itself.
    env.INTERAGENT_DIR = getInterAgentDir();
    env.MY_TAB_ID = terminalId;

    // The statusLine script has no other way to say which tab it belongs to: Claude Code
    // hands it the session data on stdin, and the extension only ever sees PTY bytes.
    // These two variables are the whole contract — the script writes <tab id>.json into
    // the directory, the watcher reads it back.
    env.CLAUDE_PANEL_TAB_ID = terminalId;
    env.CLAUDE_PANEL_STATUS_DIR = getStatusLineDir();

    if (config.statusLineProvider === 'bundled') {
      env.CLAUDE_PANEL_COMPACT_BUDGET = String(config.statusLineCompactBudget);
      // Hand the user's own command to the producer instead of losing its side effects
      const delegate = this.getUserStatusLineCommand();
      if (delegate !== undefined) {
        env.CLAUDE_PANEL_DELEGATE = delegate;
      } else {
        delete env.CLAUDE_PANEL_DELEGATE;
      }
    } else {
      // VS Code itself may have been started from a panel terminal, in which case these are
      // inherited from `process.env` and would point the producer at the wrong tab.
      delete env.CLAUDE_PANEL_COMPACT_BUDGET;
      delete env.CLAUDE_PANEL_DELEGATE;
    }

    // Remove CI flag so Claude doesn't think it's in CI
    delete env.CI;

    return env;
  }

  private createPty(
    config: TerminalConfig,
    shell: string,
    cols: number,
    rows: number,
    cwd: string,
    env: Record<string, string>
  ): IPty {
    if (!this.nodePty) {
      throw new Error('node-pty not loaded');
    }

    const spawnOptions = {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env
    };

    if (config.directMode && config.command) {
      const resolved = this.resolveCommand(config.command);
      return this.nodePty.spawn(resolved, config.args, spawnOptions);
    }
    return this.nodePty.spawn(shell, [], spawnOptions);
  }

  /**
   * Turns a bare command name into an absolute path so it spawns regardless of the PATH the
   * extension host was launched with. On macOS that PATH comes from Finder/Dock, which often
   * omits the user-local dirs where CLI agents actually live (`~/.local/bin`, `~/.opencode/bin`).
   * A missing binary is not reported — node-pty silently exits with code 1 — so `claude` from
   * `~/.local/bin` works while `opencode` from `~/.opencode/bin` failed on this machine.
   *
   * Given a path already, it is passed through unchanged. Unresolvable names fall back to the
   * original, preserving the not-found behaviour the user can see and fix in their settings.
   */
  private resolveCommand(command: string): string {
    if (!command || command.includes('/') || path.isAbsolute(command)) {
      return command;
    }

    const candidates = this.searchDirs();
    for (const abs of this.commandCandidates(command)) {
      for (const dir of candidates) {
        if (this.isExecutableFile(path.join(dir, abs))) {
          return path.join(dir, abs);
        }
      }
    }
    return command;
  }

  /** Directories searched for a CLI binary: the extension-host PATH plus agent bin dirs. */
  private searchDirs(): string[] {
    const dirs = new Set<string>();
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      if (dir) dirs.add(dir);
    }
    // Where CLIs land that a login shell adds to PATH but a Finder-launched host does not.
    for (const dir of [
      path.join(os.homedir(), '.local', 'bin'),
      path.join(os.homedir(), '.opencode', 'bin'),
      path.join(os.homedir(), 'bin')
    ]) {
      dirs.add(dir);
    }
    return Array.from(dirs);
  }

  /** The command name plus its platform executable extensions. */
  private commandCandidates(command: string): string[] {
    const candidates = [command];
    if (process.platform === 'win32') {
      const match = command.match(/\.(exe|cmd|bat)$/i);
      if (match) {
        return [command];
      }
      candidates.push(`${command}.exe`, `${command}.cmd`, `${command}.bat`);
    }
    return candidates;
  }

  private isExecutableFile(file: string): boolean {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Both handlers check that the process they belong to is still the tab's current one.
   *
   * A restart kills the old PTY and starts a new one under the same tab id, and the old one's
   * exit arrives whenever the operating system gets around to it. Reported blindly it became
   * `[Process exited with code 129]` — 128 + SIGHUP, the kill itself — printed into the session
   * that had just replaced it. The identity check is exact where a timer was not: `ptys` holds
   * the current instance, so anything else is a process this class has already retired.
   */
  private setupPtyEventHandlers(terminalId: string, pty: IPty): void {
    // The one number that separates the panel's share of a slow start from the CLI's. Measured
    // here rather than guessed: OpenCode takes about five seconds to its first visible output,
    // Claude Code a fraction of that, and both go through exactly this line.
    let firstOutput = true;

    pty.onData((data: string) => {
      if (this.ptys.get(terminalId) !== pty) return;
      if (firstOutput) {
        firstOutput = false;
        const started = this.startedAt.get(terminalId);
        if (started !== undefined) {
          log('pty', `${terminalId} first output after ${String(Date.now() - started)} ms`);
        }
      }
      this.callbacks.onData(terminalId, data);
    });

    pty.onExit(({ exitCode, signal }) => {
      const started = this.startedAt.get(terminalId);
      const lived = started !== undefined ? `${String(Date.now() - started)} ms` : 'unknown age';
      const retired = this.ptys.get(terminalId) !== pty;
      if (!retired) {
        this.startedAt.delete(terminalId);
      }
      log(
        'pty',
        `${terminalId} exit code ${String(exitCode)}${signal !== undefined ? ` signal ${String(signal)}` : ''} after ${lived}${retired ? ' (retired instance, not reported)' : ''}`
      );
      if (retired) return;
      this.callbacks.onExit(terminalId, exitCode);
    });
  }

  private handleAutoRun(pty: IPty, config: TerminalConfig): void {
    if (!config.directMode && config.autoRun && config.command) {
      const fullCommand = [config.command, ...config.args].join(' ');
      // Clear screen and run command
      pty.write('clear && ' + fullCommand + '\r');
    }
  }

  /**
   * Writes data to the PTY.
   *
   * Loud about an unknown id on purpose: this class is the only PTY owner, so a write for an
   * id it does not know is a routing mistake. Silent optional chaining hid exactly that for three
   * commits, while a second owner held the PTYs — every keystroke dropped, nothing in the log.
   */
  write(terminalId: string, data: string): void {
    const pty = this.ptys.get(terminalId);
    if (!pty) {
      console.warn(
        `[pty] write to unknown terminal ${terminalId} — dropped ${String(data.length)} bytes`
      );
      return;
    }
    pty.write(data);
  }

  /**
   * Resizes the PTY. Same reasoning as `write` for the unknown id.
   */
  resize(terminalId: string, cols: number, rows: number): void {
    const pty = this.ptys.get(terminalId);
    if (!pty) {
      console.warn(`[pty] resize of unknown terminal ${terminalId}`);
      return;
    }
    pty.resize(cols, rows);
  }

  /**
   * Kills a specific PTY.
   */
  kill(terminalId: string): void {
    const pty = this.ptys.get(terminalId);
    if (pty) {
      try {
        pty.kill();
      } catch {
        // Ignore errors when killing
      }
      this.ptys.delete(terminalId);
    }
  }

  /**
   * Kills all PTYs.
   */
  killAll(): void {
    for (const terminalId of this.ptys.keys()) {
      this.kill(terminalId);
    }
  }
}
