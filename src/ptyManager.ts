import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import type { IPty, INodePty, TerminalConfig } from './types';
import { getStatusLineDir } from './statusLineWatcher';

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
      this.setupPtyEventHandlers(terminalId, pty);
      this.handleAutoRun(pty, effectiveConfig);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
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
    const env = this.buildEnvironment(
      config.env,
      config.statusLine ? { terminalId, config } : undefined
    );
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
    statusLine?: { terminalId: string; config: TerminalConfig }
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

    // The statusLine script has no other way to say which tab it belongs to: Claude Code
    // hands it the session data on stdin, and the extension only ever sees PTY bytes.
    // These two variables are the whole contract — the script writes <tab id>.json into
    // the directory, the watcher reads it back.
    if (statusLine !== undefined) {
      env.CLAUDE_PANEL_TAB_ID = statusLine.terminalId;
      env.CLAUDE_PANEL_STATUS_DIR = getStatusLineDir();

      if (statusLine.config.statusLineProvider === 'bundled') {
        env.CLAUDE_PANEL_COMPACT_BUDGET = String(statusLine.config.statusLineCompactBudget);
        // Hand the user's own command to the producer instead of losing its side effects
        const delegate = this.getUserStatusLineCommand();
        if (delegate !== undefined) {
          env.CLAUDE_PANEL_DELEGATE = delegate;
        } else {
          delete env.CLAUDE_PANEL_DELEGATE;
        }
      } else {
        delete env.CLAUDE_PANEL_COMPACT_BUDGET;
        delete env.CLAUDE_PANEL_DELEGATE;
      }
    } else {
      delete env.CLAUDE_PANEL_TAB_ID;
      delete env.CLAUDE_PANEL_STATUS_DIR;
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
      return this.nodePty.spawn(config.command, config.args, spawnOptions);
    }
    return this.nodePty.spawn(shell, [], spawnOptions);
  }

  private setupPtyEventHandlers(terminalId: string, pty: IPty): void {
    pty.onData((data: string) => {
      this.callbacks.onData(terminalId, data);
    });

    pty.onExit(({ exitCode }) => {
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
   */
  write(terminalId: string, data: string): void {
    this.ptys.get(terminalId)?.write(data);
  }

  /**
   * Resizes the PTY.
   */
  resize(terminalId: string, cols: number, rows: number): void {
    this.ptys.get(terminalId)?.resize(cols, rows);
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
