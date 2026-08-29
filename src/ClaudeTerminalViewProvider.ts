import * as vscode from 'vscode';
import * as nodePath from 'path';
import { randomBytes } from 'crypto';
import { PtyManager, type PtyEventCallbacks, getInterAgentDir } from './ptyManager';
import { ConfigManager } from './configManager';
import { TerminalStateManager } from './terminalStateManager';
import { dispatchMessage, type MessageHandlerContext } from './messageHandlers';
import type {
  WebviewMessage,
  TerminalInstance,
  TerminalConfig,
  ExtensionMessage,
  EditorContext,
  StatusLineSnapshot,
  Engine
} from './types';
import { ENGINE_ACCENT_COLORS } from './types';
import { CommandInputPicker } from './commandInputPicker';
import { PromptDetector, type PromptDetectorConfig } from './promptDetector';
import { StatusLineWatcher } from './statusLineWatcher';
import { EditorContextTracker } from './editorContextTracker';
import { spawnSidecar, SidecarProcess } from './sidecar/index';
import { InterAgentRouter } from './interagent/InterAgentRouter';

/**
 * Wraps text in the bracketed paste markers so a multi-line insert stays one input.
 *
 * Without them every `\n` reads as Enter, and a five-line snippet fires five half-written
 * prompts instead of pasting a block. Claude Code enables bracketed paste mode (`CSI ?2004h`),
 * which is what makes this the same thing a real paste would send.
 */
function bracketedPaste(text: string): string {
  if (!text.includes('\n')) {
    return text;
  }
  return `\x1b[200~${text}\x1b[201~`;
}

export class ClaudeTerminalViewProvider
  implements vscode.WebviewViewProvider, MessageHandlerContext
{
  private view?: vscode.WebviewView;
  private disposed = false;
  private isRestarting = false;
  private lastCols = 80;
  private lastRows = 24;

  private readonly configManager = new ConfigManager();
  private readonly stateManager = new TerminalStateManager();
  private readonly ptyManager: PtyManager;
  private readonly commandPicker = new CommandInputPicker();
  private readonly promptDetector: PromptDetector;
  private readonly statusLineWatcher: StatusLineWatcher;
  private readonly editorTracker: EditorContextTracker;

  /** Sidecar processes, keyed by terminalId. Used when useSidecar is enabled. */
  private readonly sidecars = new Map<string, SidecarProcess>();

  /** Inter-agent router for message delivery between tabs. */
  private interAgentRouter: InterAgentRouter | null = null;

  /**
   * Tabs that have already been told they are over the context threshold. Cleared again only once
   * the tab drops a full ten points below it — right at the line a snapshot arrives every few
   * seconds and would otherwise raise the same warning over and over.
   */
  private readonly thresholdNotified = new Set<string>();

  /**
   * Tracks the last known terminal appearance. OpenCode's TUI only re-resolves its static theme
   * when it is poked (the `\x1b[?997;1n` notification), and that poke has to land only after the
   * webview has actually re-painted xterm's new background — otherwise OpenCode re-queries against
   * the still-stale colour and flips the wrong way. So the poke itself is deferred to the webview's
   * `themeApplied` message; this flag records whether the appearance actually changed.
   */
  private appearanceChanged = false;
  private lastAppearance: 'dark' | 'light' = this.resolveAppearance();
  private readonly themeSubscription: vscode.Disposable;

  constructor(private readonly extensionUri: vscode.Uri) {
    const callbacks: PtyEventCallbacks = {
      onData: this.handlePtyData.bind(this),
      onExit: this.handlePtyExit.bind(this),
      onError: this.handlePtyError.bind(this)
    };
    this.ptyManager = new PtyManager(callbacks, extensionUri);

    // Initialize prompt detector for input waiting notifications
    this.promptDetector = new PromptDetector(
      this.getPromptDetectorConfig(),
      this.handleNotificationChange.bind(this)
    );

    this.statusLineWatcher = new StatusLineWatcher((terminalId, snapshot) => {
      this.postMessage({ type: 'statusLine', id: terminalId, data: snapshot });
      this.checkContextThreshold(terminalId, snapshot);
    });

    // The tracker runs whatever the setting says: `editorContext` only decides whether the row
    // is drawn, while the reference command stays useful either way — and toggling the setting
    // then takes effect without a window reload.
    this.editorTracker = new EditorContextTracker((context) => {
      this.sendEditorContext(context);
    });

    // Initialize inter-agent router for cross-tab messaging
    this.interAgentRouter = new InterAgentRouter();

    // Pre-load help for the configured command. Probing the other CLI agents spawns a
    // process per candidate on every window start, so it is opt-in.
    const config = this.configManager.getConfig();
    this.commandPicker.preloadCommands(
      config.preloadHelp
        ? [config.command, 'claude', 'gemini', 'aider', 'codex', 'gh', 'interpreter', 'opencode']
        : [config.command]
    );

    // OpenCode's TUI only re-resolves its static theme after a `\x1b[?997;1n` notification triggers
    // a palette re-query (see `handleThemeNotification` in opencode's `packages/tui/src/context/theme.tsx`).
    // But poking at the moment VS Code's theme event fires races the webview's 50 ms sample delay,
    // so this only records that the appearance bucket changed; the actual poke is deferred to the
    // webview's `themeApplied` message in `handleThemeApplied()`.
    this.themeSubscription = vscode.window.onDidChangeActiveColorTheme(() => {
      const current = this.resolveAppearance();
      const last = this.lastAppearance;
      this.lastAppearance = current;
      if (current !== last) {
        this.appearanceChanged = true;
      }
    });
  }

  /** The appearance bucket OpenCode derives its theme mode from. */
  private resolveAppearance(): 'dark' | 'light' {
    switch (vscode.window.activeColorTheme.kind) {
      case vscode.ColorThemeKind.Light:
      case vscode.ColorThemeKind.HighContrastLight:
        return 'light';
      default:
        return 'dark';
    }
  }

  /**
   * Called from the webview after it has re-applied its xterm theme (so xterm's background is
   * already the new one). Only then is it safe to poke the OpenCode tabs: OpenCode re-queries the
   * terminal palette, derives the mode from the background it gets back, and flips its static
   * theme's light/dark variant.
   */
  handleThemeApplied(): void {
    if (!this.appearanceChanged) {
      return;
    }
    this.appearanceChanged = false;
    for (const tab of this.stateManager.getAll()) {
      if (tab.engine === 'opencode') {
        this.ptyManager.write(tab.id, '\x1b[?997;1n');
      }
    }
  }

  // --- MessageHandlerContext Implementation ---

  handleReady(cols: number, rows: number): void {
    this.lastCols = cols;
    this.lastRows = rows;
    // A reloaded webview starts empty; the editor is whatever it was before the reload
    this.sendEditorContext(this.editorTracker.current);
    this.sendContextThreshold();
    void this.createTerminal();
  }

  handleInput(id: string, data: string): void {
    this.ptyManager.write(id, data);
    this.promptDetector.onUserInput(id);
  }

  /**
   * The status line's stop button: the Escape key. Claude interrupts the turn and keeps the work
   * done so far.
   *
   * A named message rather than a general "write these bytes to the PTY" — the webview renders
   * model-generated output, so the channel out of it has to stay a command, not a keyboard.
   */
  handleStopTurn(id: string): void {
    this.ptyManager.write(id, '\x1b');
  }

  /**
   * The slider on the context bar. Written to the workspace so it travels with the project — a
   * 1M window and a 200k one do not want the same warning point.
   *
   * Falls back through the targets rather than assuming one: `update` with a workspace target
   * throws when no folder is open, which is exactly the case a scratch window is in.
   */
  handleSetContextThreshold(value: number): void {
    const clamped = Math.min(95, Math.max(5, Math.round(value)));
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;

    void vscode.workspace
      .getConfiguration('claudeTerminal')
      .update('contextThreshold', clamped, target)
      .then(undefined, (error: unknown) => {
        void vscode.window.showWarningMessage(
          `Could not save the context threshold: ${String(error)}`
        );
      });
  }

  handleResize(id: string, cols: number, rows: number): void {
    this.lastCols = cols;
    this.lastRows = rows;
    this.ptyManager.resize(id, cols, rows);
  }

  handleNewTab(): void {
    this.promptNewTab();
  }

  /**
   * New tab entry point for the `+` button and the `claudeTerminal.newTab` shortcut:
   * ask which engine to run, then open the tab. The very first tab (empty panel) is
   * spawned directly with the configured engine instead of asking.
   */
  public promptNewTab(): void {
    void this.promptAndCreateTerminal();
  }

  handleNewTabWithCommand(): void {
    void this.promptAndCreateTerminalWithCommand();
  }
  handleCloseTab(id: string): void {
    this.closeTerminal(id);
  }

  handleSwitchTab(id: string): void {
    this.switchToTerminal(id);
  }

  handleInsertEditorReference(): void {
    this.insertEditorReference();
  }

  /**
   * Writes the open file — and the selected lines, if any — into the active tab's input.
   *
   * Deliberately without a newline: this lands in Claude's prompt, and sending it stays the
   * user's decision. Nothing is appended automatically anywhere else, so context only ever
   * leaves the editor when it is asked for.
   *
   * The caret follows the text. The shortcut is pressed with the focus in the editor, so
   * whatever is typed next would otherwise be typed into the file the reference points at —
   * an edit nobody asked for, in the document currently under discussion.
   */
  public insertEditorReference(): void {
    const activeId = this.stateManager.getActiveId();
    if (!activeId) {
      return;
    }

    const text = this.editorTracker.currentPromptText();
    if (text === null) {
      void vscode.window.showInformationMessage(
        'Claude Terminal: no file is open in the editor to reference.'
      );
      return;
    }

    this.ptyManager.write(activeId, bracketedPaste(text));

    // Two steps, and both are needed: `show` reveals the view and moves VS Code's focus to it,
    // then the webview hands the caret to xterm's textarea.
    this.view?.show(false);
    this.postMessage({ type: 'focusTerminal' });
  }

  handleOpenFile(id: string, path: string, line?: number, column?: number): void {
    const instance = this.stateManager.get(id);
    const cwd = instance?.cwd;
    void this.openFileInEditor(path, cwd, line, column);
  }

  private async openFileInEditor(
    filePath: string,
    terminalCwd?: string,
    line?: number,
    column?: number
  ): Promise<void> {
    try {
      // Expand tilde to home directory
      let resolvedPath = filePath;
      if (resolvedPath.startsWith('~/')) {
        const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? '';
        resolvedPath = resolvedPath.replace('~', homeDir);
      }

      // Resolve relative paths using terminal's cwd or workspace folder
      let uri: vscode.Uri;
      if (resolvedPath.startsWith('/') || /^[a-zA-Z]:/.test(resolvedPath)) {
        // Absolute path
        uri = vscode.Uri.file(resolvedPath);
      } else if (terminalCwd) {
        // Relative path - resolve from terminal's working directory
        uri = vscode.Uri.file(`${terminalCwd}/${resolvedPath}`);
      } else {
        // Fallback to workspace folder
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
          uri = vscode.Uri.joinPath(workspaceFolders[0].uri, resolvedPath);
        } else {
          uri = vscode.Uri.file(resolvedPath);
        }
      }

      // Terminal output is partly model-generated, so a link is not proof that opening
      // the target is wanted. Anything outside the workspace or the terminal's cwd asks.
      if (!this.isWithinAllowedRoots(uri.fsPath, terminalCwd)) {
        const open = 'Open anyway';
        const choice = await vscode.window.showWarningMessage(
          `Claude Terminal: this path is outside the workspace and the terminal's directory: ${uri.fsPath}`,
          open
        );
        if (choice !== open) {
          return;
        }
      }

      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document);

      // Navigate to line/column if specified
      if (line !== undefined && line > 0) {
        const position = new vscode.Position(
          line - 1,
          column !== undefined && column > 0 ? column - 1 : 0
        );
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(
          new vscode.Range(position, position),
          vscode.TextEditorRevealType.InCenter
        );
      }
    } catch (error) {
      // Log error for debugging but don't show disruptive notifications
      console.warn(`[Claude Terminal] Failed to open file: ${filePath}`, error);
    }
  }

  /**
   * Whether a resolved path sits inside a workspace folder or the terminal's cwd.
   * Compares with a trailing separator so `/foo/barbaz` does not count as `/foo/bar`.
   */
  private isWithinAllowedRoots(candidate: string, terminalCwd?: string): boolean {
    const roots = [
      ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      ...(terminalCwd ? [terminalCwd] : [])
    ];

    if (roots.length === 0) {
      return true;
    }

    const target = nodePath.resolve(candidate);
    return roots.some((root) => {
      const base = nodePath.resolve(root);
      return target === base || target.startsWith(base + nodePath.sep);
    });
  }

  // --- PTY Event Handlers ---

  private handlePtyData(terminalId: string, data: string): void {
    if (!this.disposed && this.view) {
      this.postMessage({ type: 'output', id: terminalId, data });
      this.promptDetector.onData(terminalId, data);
    }
  }

  private handlePtyExit(terminalId: string, exitCode: number | null): void {
    if (!this.disposed && this.view && !this.isRestarting) {
      this.postMessage({
        type: 'output',
        id: terminalId,
        data: `\r\n[Process exited with code ${String(exitCode ?? 0)}]\r\n`
      });
    }
  }

  private handlePtyError(terminalId: string, error: string): void {
    this.postMessage({
      type: 'output',
      id: terminalId,
      data: `\r\nError starting terminal: ${error}\r\n`
    });
  }

  // --- WebviewViewProvider Implementation ---

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
      dispatchMessage(message, this);
    });

    webviewView.onDidDispose(() => {
      this.ptyManager.killAll();
    });
  }

  // --- Terminal Management (Public API) ---

  /**
   * Opens a new tab with the given engine. The engineering lives in the tab model:
   * `restart`/`resume`/`continue` read the engine back from the active tab instead of
   * assuming the configured engine, so a tab keeps its CLI across respawns.
   */
  public async createTerminal(engine: Engine = 'claude'): Promise<string> {
    const id = this.stateManager.generateId();
    const name = this.stateManager.generateName(engine);

    // Select working directory first to get folder index
    const { path: cwd, folderIndex } = await this.ptyManager.selectWorkingDirectory(
      this.configManager.getConfig().cwd
    );

    const instance: TerminalInstance = {
      id,
      name,
      pty: undefined,
      isActive: false,
      workspaceFolderIndex: folderIndex,
      cwd,
      engine
    };

    // Add instance first, then activate (so setActive can find it)
    this.stateManager.set(id, instance);
    this.stateManager.setActive(id);

    // Notify webview with accent color
    const accentColor = this.getAccentColor(engine);
    this.postMessage({ type: 'createTab', id, name, accentColor });
    this.sendTabsUpdate();
    this.sendInitialStatusLine(id, cwd);

    // Start the terminal process (sidecar or direct PTY)
    const config = this.engineConfig(engine);
    if (config.useSidecar) {
      this.spawnSidecar(id, config, cwd);
    } else {
      this.ptyManager.spawn(id, config, this.lastCols, this.lastRows, cwd);
    }

    // Switch to the new tab
    this.postMessage({ type: 'switchTab', id });

    return id;
  }

  /**
   * Spawns a sidecar process for the given terminal.
   * The sidecar manages the PTY and inter-agent messaging.
   */
  private spawnSidecar(terminalId: string, config: TerminalConfig, cwd?: string): void {
    const workingDir =
      cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.env.HOME ?? '/';
    const interagentDir = getInterAgentDir();
    const env = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FORCE_COLOR: '1',
      INTERAGENT_DIR: interagentDir,
      MY_TAB_ID: terminalId
    };

    // Spawn the sidecar (in-process module; the extension host loads and runs it)
    const sidecar = spawnSidecar({
      tabId: terminalId,
      engine: config.command === 'claude' ? 'claude' : 'opencode',
      command: this.ptyManager.resolveCommand(config.command),
      args: config.args,
      cwd: workingDir,
      cols: this.lastCols,
      rows: this.lastRows,
      env,
      interagentDir,
      onOutput: (tabId: string, data: string) => {
        this.handlePtyData(tabId, data);
      },
      onExit: (tabId: string, code: number | null, _signal: number | null) => {
        this.handlePtyExit(tabId, code);
      },
      onError: (tabId: string, message: string) => {
        this.handlePtyError(tabId, message);
      },
      onReady: (tabId: string) => {
        // Register with inter-agent router
        const instance = this.stateManager.get(tabId);
        if (instance) {
          this.interAgentRouter?.registerPresence(tabId, {
            engine: instance.engine,
            cwd: instance.cwd ?? workingDir,
            cols: this.lastCols,
            rows: this.lastRows,
            ts: Date.now()
          });
        }
      }
    });

    this.sidecars.set(terminalId, sidecar);
  }

  /**
   * Asks the user which CLI to run before opening a new tab.
   */
  private async promptAndCreateTerminal(): Promise<void> {
    const engine = await this.promptForEngine();
    if (!engine) {
      return;
    }
    await this.createTerminal(engine);
  }

  /**
   * QuickPick for the engine choice behind `+` and the new-tab shortcut: Claude Code or
   * OpenCode. Everything else (custom command, --resume/--continue) is reachable through
   * its own entry points.
   */
  private async promptForEngine(): Promise<Engine | undefined> {
    const config = this.configManager.getConfig();
    const items = [
      {
        label: '$(comment-discussion) Claude Code',
        description: `Run: ${[config.command, ...config.args].join(' ')}`,
        engine: 'claude' as const
      },
      {
        label: '$(terminal-bash) OpenCode',
        description: `Run: ${config.opencodeCommand}`,
        engine: 'opencode' as const
      }
    ];

    const picked = await vscode.window.showQuickPick(items, {
      title: 'New Terminal',
      placeHolder: 'Choose the CLI to run'
    });

    return picked?.engine;
  }

  private async promptAndCreateTerminalWithCommand(): Promise<void> {
    const config = this.configManager.getConfig();
    const defaultCommand = [config.command, ...config.args].join(' ');

    const result = await this.commandPicker.promptForCommand(defaultCommand);

    if (!result.cancelled && result.command) {
      await this.createTerminalWithCommand(result.command, result.args);
    }
  }

  public async createTerminalWithCommand(command: string, args: string[]): Promise<string> {
    const id = this.stateManager.generateId();
    // A hand-typed command is not necessarily Claude; only Claude gets the engineered tab
    // semantics. Careful with opencode: the name/label still follows the command.
    const engine: Engine =
      nodePath.basename(command).replace(/\.(exe|cmd|bat)$/i, '') === 'claude'
        ? 'claude'
        : 'opencode';
    const name = this.stateManager.generateName(engine);

    // Select working directory first to get folder index
    const { path: cwd, folderIndex } = await this.ptyManager.selectWorkingDirectory(
      this.configManager.getConfig().cwd
    );

    const instance: TerminalInstance = {
      id,
      name,
      pty: undefined,
      isActive: false,
      workspaceFolderIndex: folderIndex,
      cwd,
      engine
    };

    this.stateManager.set(id, instance);
    this.stateManager.setActive(id);

    const accentColor = this.getAccentColor(engine);
    this.postMessage({ type: 'createTab', id, name, accentColor });
    this.sendTabsUpdate();
    this.sendInitialStatusLine(id, cwd);

    // Use provided command/args instead of config
    const customConfig = { ...this.engineConfig(engine), command, args };
    if (customConfig.useSidecar) {
      this.spawnSidecar(id, customConfig, cwd);
    } else {
      this.ptyManager.spawn(id, customConfig, this.lastCols, this.lastRows, cwd);
    }

    this.postMessage({ type: 'switchTab', id });

    return id;
  }

  /**
   * Opens a tab that resumes earlier work instead of starting a fresh conversation.
   * Session history is stored per working directory, so the resulting list depends on
   * the tab's cwd — which the tab tooltip shows.
   *
   * `--resume`/`--continue` are Claude-specific flags; OpenCode has its own session flow
   * under `/sessions`, so this is only wired to the Claude engine.
   */
  public async createTerminalWithSessionFlag(flag: '--continue' | '--resume'): Promise<string> {
    const engine: Engine = 'claude';
    const config = this.engineConfig(engine);
    return this.createTerminalWithCommand(config.command, [...config.args, flag]);
  }

  public closeTerminal(terminalId: string): void {
    const instance = this.stateManager.get(terminalId);
    if (!instance) return;

    // Kill sidecar if present
    const sidecar: SidecarProcess | undefined = this.sidecars.get(terminalId);
    if (sidecar) {
      sidecar.kill();
      this.sidecars.delete(terminalId);
    }

    this.ptyManager.kill(terminalId);
    this.promptDetector.removeTerminal(terminalId);
    this.statusLineWatcher.removeTerminal(terminalId);
    this.thresholdNotified.delete(terminalId);
    this.interAgentRouter?.unregisterPresence(terminalId);
    this.stateManager.delete(terminalId);
    this.postMessage({ type: 'removeTab', id: terminalId });

    // Handle active terminal closure
    if (this.stateManager.getActiveId() === terminalId) {
      this.handleActiveTerminalClosed();
      return;
    }

    this.sendTabsUpdate();
  }

  private handleActiveTerminalClosed(): void {
    const remaining = this.stateManager.getAll();
    if (remaining.length > 0) {
      const newActive = remaining[remaining.length - 1];
      this.switchToTerminal(newActive.id);
    } else {
      this.stateManager.clearActive();
      void this.createTerminal();
      return;
    }
    this.sendTabsUpdate();
  }

  public closeActiveTerminal(): void {
    const activeId = this.stateManager.getActiveId();
    if (activeId) {
      this.closeTerminal(activeId);
    }
  }

  public switchToTerminal(terminalId: string): void {
    const instance = this.stateManager.get(terminalId);
    if (!instance) return;

    this.stateManager.setActive(terminalId);
    this.postMessage({ type: 'switchTab', id: terminalId });
    this.sendTabsUpdate();
  }

  public switchToNextTerminal(): void {
    const ids = this.stateManager.getAllIds();
    if (ids.length <= 1) return;

    const currentIndex = ids.indexOf(this.stateManager.getActiveId() ?? '');
    const nextIndex = (currentIndex + 1) % ids.length;
    this.switchToTerminal(ids[nextIndex]);
  }

  public switchToPreviousTerminal(): void {
    const ids = this.stateManager.getAllIds();
    if (ids.length <= 1) return;

    const currentIndex = ids.indexOf(this.stateManager.getActiveId() ?? '');
    const prevIndex = (currentIndex - 1 + ids.length) % ids.length;
    this.switchToTerminal(ids[prevIndex]);
  }

  public restart(): void {
    this.respawnActive([]);
  }

  /**
   * Respawns the active tab with `--resume`, so Claude offers the session list for the
   * tab's own directory instead of starting a fresh conversation. No new tab.
   */
  public resumeActiveTerminal(): void {
    this.respawnActive(['--resume']);
  }

  /** Respawns the active tab with `--continue`: straight back into its last session. */
  public continueActiveTerminal(): void {
    this.respawnActive(['--continue']);
  }

  /**
   * Kills the active tab's process and starts it again in the tab's own directory.
   * Without that cwd the new PTY falls back to the first workspace folder, which
   * silently changes which session history applies.
   */
  private respawnActive(extraArgs: string[]): void {
    const activeId = this.stateManager.getActiveId();
    if (!activeId) return;

    this.isRestarting = true;
    this.thresholdNotified.delete(activeId);

    // Kill sidecar if present
    const sidecar: SidecarProcess | undefined = this.sidecars.get(activeId);
    if (sidecar) {
      sidecar.kill();
      this.sidecars.delete(activeId);
    }

    this.ptyManager.kill(activeId);

    // Delay to let old PTY exit event fire before resetting flag
    setTimeout(() => {
      this.isRestarting = false;
    }, 100);

    // The tab keeps its own engine: a restart on an OpenCode tab must come back as
    // OpenCode, not silently fall back to the configured Claude command. Resume/continue
    // flags are Claude-specific, so they only apply to Claude tabs.
    const active = this.stateManager.get(activeId);
    const engine = active?.engine ?? 'claude';
    const config = this.engineConfig(engine);
    const cwd = active?.cwd;
    const spawnConfig =
      engine === 'claude' && extraArgs.length > 0
        ? { ...config, args: [...config.args, ...extraArgs] }
        : config;
    if (config.useSidecar) {
      this.spawnSidecar(activeId, spawnConfig, cwd);
    } else {
      this.ptyManager.spawn(activeId, spawnConfig, this.lastCols, this.lastRows, cwd);
    }
  }

  /**
   * The effective command for an engine. OpenCode tabs run the configured OpenCode command
   * (default `opencode`) with no Claude-specific args; Claude tabs use `command` + `args`.
   */
  private engineConfig(engine: Engine): TerminalConfig {
    const config = this.configManager.getConfig();
    if (engine === 'opencode') {
      return { ...config, command: config.opencodeCommand, args: [] };
    }
    return config;
  }

  public clear(): void {
    const activeId = this.stateManager.getActiveId();
    if (activeId) {
      this.postMessage({ type: 'clear', id: activeId });
    }
  }

  public updateConfig(): void {
    this.configManager.invalidateCache();
    this.promptDetector.updateConfig(this.getPromptDetectorConfig());
    // `editorContext` may have just been switched: redraw the row rather than wait for the next
    // time the user happens to move the cursor
    this.sendEditorContext(this.editorTracker.current);
    this.sendContextThreshold();
  }

  public dispose(): void {
    this.disposed = true;
    this.themeSubscription.dispose();
    this.ptyManager.killAll();
    for (const sidecar of this.sidecars.values()) {
      sidecar.kill();
    }
    this.sidecars.clear();
    this.interAgentRouter?.dispose();
    this.promptDetector.dispose();
    this.statusLineWatcher.dispose();
    this.editorTracker.dispose();
    this.configManager.dispose();
    this.commandPicker.dispose();
  }

  // --- Private Helpers ---

  private getPromptDetectorConfig(): PromptDetectorConfig {
    const vsConfig = vscode.workspace.getConfiguration('claudeTerminal');
    return {
      enabled: vsConfig.get<boolean>('promptNotification', true),
      showDelay: vsConfig.get<number>('promptNotificationDelay', 300),
      customPatterns: vsConfig.get<string[]>('promptPatterns', [])
    };
  }

  /**
   * Fills the status line the moment a tab exists. Claude Code only runs the statusLine command
   * once it renders, which is after its first output, so without this the row would appear
   * several seconds late — and change the terminal height while the user is already typing.
   */
  /** Suppressed as `null` rather than skipped, so switching the setting off clears the row. */
  private sendEditorContext(context: EditorContext | null): void {
    const enabled = this.configManager.getConfig().editorContext;
    this.postMessage({ type: 'editorContext', data: enabled ? context : null });
  }

  private sendContextThreshold(): void {
    this.postMessage({
      type: 'contextThreshold',
      value: this.configManager.getConfig().contextThreshold
    });
  }

  /**
   * Warns once when a tab crosses the threshold, and re-arms only well below it.
   *
   * The tab is named because the warning can come from a tab that is not on screen — the watcher
   * reports every tab, not just the active one.
   */
  private checkContextThreshold(terminalId: string, snapshot: StatusLineSnapshot | null): void {
    const threshold = this.configManager.getConfig().contextThreshold;
    const percent = snapshot?.usedPercent;

    if (percent === undefined || snapshot === null || snapshot.totalTokens <= 0) {
      return;
    }

    if (percent < threshold - 10) {
      this.thresholdNotified.delete(terminalId);
      return;
    }

    if (percent < threshold || this.thresholdNotified.has(terminalId)) {
      return;
    }

    this.thresholdNotified.add(terminalId);
    const name = this.stateManager.get(terminalId)?.name ?? 'Terminal';
    void vscode.window
      .showWarningMessage(
        `${name}: context at ${String(Math.round(percent))}% of the ${String(threshold)}% threshold — consider /clear.`,
        'Run /clear',
        'Dismiss'
      )
      .then((choice) => {
        if (choice !== 'Run /clear') return;
        // Straight into the tab that raised it, which is not necessarily the active one.
        // `\r` is Enter, the same way autoRun submits its command.
        this.ptyManager.write(terminalId, '/clear\r');
        this.promptDetector.onUserInput(terminalId);
      });
  }

  private sendInitialStatusLine(terminalId: string, cwd: string | undefined): void {
    // Only Claude tabs have a status line; an OpenCode tab must not inherit a stale
    // remembered snapshot from a previous Claude session in the same directory.
    if (this.stateManager.get(terminalId)?.engine !== 'claude') {
      return;
    }
    const snapshot = this.statusLineWatcher.getInitialSnapshot(cwd);
    if (snapshot) {
      this.postMessage({ type: 'statusLine', id: terminalId, data: snapshot });
    }
  }

  private handleNotificationChange(terminalId: string, isWaiting: boolean): void {
    this.stateManager.setWaitingForInput(terminalId, isWaiting);
    this.postMessage({ type: 'setNotification', id: terminalId, show: isWaiting });
  }

  private getAccentColor(engine: Engine): string {
    return ENGINE_ACCENT_COLORS[engine];
  }

  private postMessage(message: ExtensionMessage): void {
    this.view?.webview.postMessage(message);
  }

  private sendTabsUpdate(): void {
    const tabs = this.stateManager.getTabsInfo();
    this.postMessage({ type: 'tabsUpdate', tabs });
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const stylesUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'styles.css')
    );
    const xtermCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'xterm.css')
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js')
    );

    const nonce = this.getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <link href="${xtermCssUri.toString()}" rel="stylesheet">
    <link href="${stylesUri.toString()}" rel="stylesheet">
</head>
<body>
    <div id="terminal-column">
        <div id="terminals-container"></div>
        <div id="status-line" hidden></div>
    </div>
    <div id="tab-bar"></div>
    <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }

  private getNonce(): string {
    return randomBytes(24).toString('base64url');
  }
}
