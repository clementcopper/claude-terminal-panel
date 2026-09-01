import * as vscode from 'vscode';
import * as nodePath from 'path';
import { randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { PtyManager, type PtyEventCallbacks } from './ptyManager';
import { ConfigManager } from './configManager';
import { TerminalStateManager } from './terminalStateManager';
import { dispatchMessage, type MessageHandlerContext } from './messageHandlers';
import type {
  WebviewMessage,
  TerminalInstance,
  TerminalGroup,
  TerminalConfig,
  ExtensionMessage,
  EditorContext,
  StatusLineSnapshot,
  Engine,
  PersistedGroup,
  PersistedLayout
} from './types';
import { ENGINE_ACCENT_COLORS } from './types';
import { PromptDetector, type PromptDetectorConfig } from './promptDetector';
import { StatusLineWatcher } from './statusLineWatcher';
import { EditorContextTracker } from './editorContextTracker';
import { InterAgentRouter } from './interagent/InterAgentRouter';
import { log } from './log';

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
  private lastCols = 80;
  private lastRows = 24;

  private readonly configManager = new ConfigManager();
  private readonly stateManager = new TerminalStateManager();
  private readonly ptyManager: PtyManager;
  private readonly promptDetector: PromptDetector;
  private readonly statusLineWatcher: StatusLineWatcher;
  private readonly editorTracker: EditorContextTracker;

  /** Inter-agent router for message delivery between tabs. */
  private interAgentRouter: InterAgentRouter | null = null;

  /**
   * Tabs whose process is waiting for the webview to report the terminal's real size.
   *
   * A PTY spawned before that knows only an estimate — `measureInitialDimensions` leaves out the
   * status line and the editor row, and a fresh xterm sits at 80x24 until its first fit. The CLI
   * then paints its opening frame for a window that is up to seven rows taller than the one it
   * lands in, which is where the wrapped boxes and leftover fragments come from.
   */
  /** How long a tab waits for the webview to report its size before starting anyway. */
  private static readonly READY_TIMEOUT_MS = 2000;

  private readonly pendingSpawns = new Map<
    string,
    { config: TerminalConfig; cwd?: string; timer: ReturnType<typeof setTimeout> }
  >();

  /**
   * Tabs that have already been told they are over the context threshold. Cleared again only once
   * the tab drops a full ten points below it — right at the line a snapshot arrives every few
   * seconds and would otherwise raise the same warning over and over.
   */
  private readonly thresholdNotified = new Set<string>();

  /**
   * Restored tabs that have never run. Their element exists so the tab is there to click, but no
   * process was started: a reload with four groups would otherwise spawn a CLI session per tab,
   * and every Claude session counts against the account's limits. The process starts the first
   * time the tab is switched to.
   */
  private readonly coldTerminals = new Set<string>();

  /** Key under which the tab layout is remembered for this workspace. */
  private static readonly LAYOUT_KEY = 'claudeTerminal.layout';

  /** Ceiling on tabs restored per group, so a corrupt entry cannot open hundreds. */
  private static readonly MAX_RESTORED_TABS = 16;

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

  constructor(
    private readonly extensionUri: vscode.Uri,
    /** Workspace-scoped, not global: groups carry working directories, which belong to a project. */
    private readonly workspaceState?: vscode.Memento
  ) {
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

    // Inter-agent router for cross-tab messaging. It owns discovery and the inbox files;
    // delivery goes back through the single PTY owner, so a message arrives on exactly the
    // path a keystroke takes.
    this.interAgentRouter = new InterAgentRouter({
      isLocalTab: (tabId) => this.stateManager.get(tabId) !== undefined,
      deliver: (tabId, kind, text) => {
        // `text` is one block and gets bracketed paste; a control string is a signal and
        // must reach the CLI raw, or it would land in the prompt as literal escape bytes.
        this.ptyManager.write(tabId, kind === 'text' ? bracketedPaste(text) : text);
      }
    });

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

    // The webview can be rebuilt while the extension host keeps running — moving the view to the
    // other sidebar does it, so does "Developer: Reload Webviews". The processes are still there;
    // only the DOM is gone. Creating a fresh tab instead of restoring them left the old ones in
    // the tab bar with no element behind them: clicking one did nothing.
    const existing = this.stateManager.getAll();
    log(
      'webview',
      `ready ${String(cols)}x${String(rows)}, ${String(existing.length)} tab(s) to restore`
    );

    if (existing.length === 0) {
      // First webview of a fresh extension host. A later rebuild (moving the panel, "Reload
      // Webviews") finds the tabs still here and takes the restore path below instead.
      void this.restoreOrCreate();
      return;
    }

    // Every terminal of every group needs its wrapper back, not just the active group's: the
    // inactive ones stay hidden, but their xterm instance and its scrollback have to exist, or
    // switching groups later would land on an empty element.
    for (const tab of existing) {
      this.postMessage({
        type: 'createTab',
        id: tab.id,
        name: tab.name,
        accentColor: this.getAccentColor(tab.engine),
        awaitingStart: false
      });
      const snapshot = this.statusLineWatcher.get(tab.id);
      if (snapshot) {
        this.postMessage({ type: 'statusLine', id: tab.id, data: snapshot });
      } else {
        this.sendInitialStatusLine(tab.id, tab.cwd);
      }
    }
    this.sendGroupsUpdate();
    this.sendTabsUpdate();

    const activeId = this.stateManager.getActiveId() ?? existing[existing.length - 1].id;
    this.stateManager.setActive(activeId);
    this.postMessage({ type: 'switchTab', id: activeId });
    // `setActive` may have moved the active group along with the tab; the bar has to follow.
    this.sendGroupsUpdate();
    this.sendTabsUpdate();
  }

  /**
   * The webview has measured the tab's terminal. Either the process is still waiting to be
   * started with those dimensions, or it is already running and only needs to be told.
   */
  handleTerminalReady(id: string, cols: number, rows: number): void {
    this.lastCols = cols;
    this.lastRows = rows;

    if (this.coldTerminals.has(id)) {
      // A restored tab reports its size as soon as its element exists, before anyone has asked
      // for a process. Nothing to spawn and nothing to resize — passing this on would log
      // "resize of unknown terminal" once per cold tab on every reload, which is exactly the
      // warning you want to still mean something when a real one shows up.
      log('tab', `${id} ready ${String(cols)}x${String(rows)} (cold, not started)`);
      return;
    }

    const pending = this.pendingSpawns.get(id);
    if (!pending) {
      // A restored tab, or one whose safety net already fired: the process exists, so this is a
      // resize and nothing more.
      log('tab', `${id} ready ${String(cols)}x${String(rows)} (already running)`);
      this.ptyManager.resize(id, cols, rows);
      return;
    }

    clearTimeout(pending.timer);
    this.pendingSpawns.delete(id);
    log('tab', `${id} ready ${String(cols)}x${String(rows)}, starting process`);
    this.ptyManager.spawn(id, pending.config, cols, rows, pending.cwd);
    this.registerPresence(id);
  }

  /**
   * Holds the tab's process until `terminalReady` arrives, and starts it anyway if it does not.
   *
   * The safety net is the point: a lost message must cost a badly sized first frame, never a tab
   * that never starts at all.
   */
  private spawnWhenMeasured(id: string, config: TerminalConfig, cwd?: string): void {
    const timer = setTimeout(() => {
      if (!this.pendingSpawns.delete(id)) return;
      log(
        'tab',
        `${id} no terminalReady within ${String(ClaudeTerminalViewProvider.READY_TIMEOUT_MS)} ms, starting at ${String(this.lastCols)}x${String(this.lastRows)}`
      );
      this.ptyManager.spawn(id, config, this.lastCols, this.lastRows, cwd);
      this.registerPresence(id);
    }, ClaudeTerminalViewProvider.READY_TIMEOUT_MS);

    this.pendingSpawns.set(id, { config, cwd, timer });
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

  /**
   * The context ring is the only threshold control left, and a click carries no value — so it
   * asks for one. The bounds are the same 5–95 the drag handle used to enforce: a threshold at
   * either end says nothing.
   */
  handlePromptContextThreshold(): void {
    const current = this.configManager.getConfig().contextThreshold;

    void vscode.window
      .showInputBox({
        title: 'Context threshold',
        prompt: 'Warn when the context window is this full (5–95%)',
        value: String(Math.round(current)),
        validateInput: (raw) => {
          const value = Number(raw.trim().replace('%', ''));
          if (!Number.isFinite(value) || !Number.isInteger(value)) {
            return 'Whole numbers only';
          }
          return value < 5 || value > 95 ? 'Between 5 and 95' : undefined;
        }
      })
      .then((raw) => {
        if (raw === undefined) return;
        this.handleSetContextThreshold(Number(raw.trim().replace('%', '')));
      });
  }

  handleResize(id: string, cols: number, rows: number): void {
    // Only a real change is worth a line — the observer fires on every panel drag frame.
    if (cols !== this.lastCols || rows !== this.lastRows) {
      log('tab', `${id} resize ${String(cols)}x${String(rows)}`);
    }
    // Worth keeping even for a tab that has not started: this is the size its process will be
    // spawned at once it is woken.
    this.lastCols = cols;
    this.lastRows = rows;
    if (this.coldTerminals.has(id)) {
      return;
    }
    this.ptyManager.resize(id, cols, rows);
  }

  handleNewTab(): void {
    this.newTabInActiveGroup();
  }

  /**
   * The `+` in the terminal bar and the `claudeTerminal.newTab` shortcut: another terminal of the
   * group's own CLI.
   *
   * No engine question here — the group already answered it, and asking again is what let a
   * purple OpenCode tab end up inside an orange Claude group, where the group's name and accent
   * bar then described only some of its terminals. The choice moved up one level: it is made once,
   * when the group is created.
   */
  public newTabInActiveGroup(): void {
    const engine = this.stateManager.getActiveGroup()?.engine ?? 'claude';
    void this.createTerminal(engine);
  }

  handleCloseTab(id: string): void {
    this.closeTerminal(id);
  }

  handleSwitchTab(id: string): void {
    this.switchToTerminal(id);
  }

  handleNewGroup(): void {
    void this.promptAndCreateGroup();
  }

  handleCloseGroup(id: string): void {
    this.closeGroup(id);
  }

  handleSwitchGroup(id: string): void {
    this.switchToGroup(id);
  }

  /**
   * The webview commits an inline rename here. It is echoed back through `groupsUpdate` rather
   * than trusted to have stuck: an empty or unchanged name is refused by the state manager, and
   * the bar then redraws the name that actually applies.
   */
  handleRenameGroup(id: string, name: string): void {
    if (this.stateManager.renameGroup(id, name)) {
      log('tab', `group ${id} renamed`);
      this.persistLayout();
    }
    this.sendGroupsUpdate();
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
    if (!this.disposed && this.view) {
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

    log('webview', 'resolve');
    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
      dispatchMessage(message, this);
    });

    // Deliberately no `killAll()` here. The webview is rebuilt for reasons that have nothing to
    // do with the sessions — the view is moved to the other sidebar, the webviews are reloaded —
    // and killing every PTY on that took the running agents with it. `dispose()` still cleans up
    // when the extension itself goes away.
    webviewView.onDidDispose(() => {
      // Only if it is still the current one: VS Code may already have resolved the replacement
      // by the time the old view reports its disposal, and clearing that would silence the
      // panel for good. Dropping the reference stops every `postMessage` into a dead webview.
      if (this.view === webviewView) {
        this.view = undefined;
      }
      log('webview', 'disposed, processes kept');
    });
  }

  // --- Terminal Management (Public API) ---

  /**
   * Opens a new tab with the given engine. The engineering lives in the tab model:
   * `restart`/`resume`/`continue` read the engine back from the active tab instead of
   * assuming the configured engine, so a tab keeps its CLI across respawns.
   */
  public async createTerminal(engine: Engine = 'claude', cold = false): Promise<string> {
    // The group owns the directory; the tab inherits it. That is also what keeps
    // `respawnActive` honest — restart/resume/continue reuse the tab's cwd, and session
    // history lives per directory.
    const group = await this.ensureActiveGroup(engine);
    const cwd = group.cwd;
    const folderIndex = group.workspaceFolderIndex;

    const id = this.stateManager.generateId();
    const name = this.stateManager.generateName(engine);

    const instance: TerminalInstance = {
      id,
      name,
      pty: undefined,
      isActive: false,
      workspaceFolderIndex: folderIndex,
      cwd,
      engine,
      groupId: group.id
    };

    // Add instance first, then activate (so setActive can find it)
    this.stateManager.set(id, instance);
    this.stateManager.setActive(id);

    // Notify webview with accent color. A cold tab is not starting anything, so it gets no
    // "starting…" indicator — that would promise a process nobody asked for yet.
    const accentColor = this.getAccentColor(engine);
    this.postMessage({ type: 'createTab', id, name, accentColor, awaitingStart: !cold });
    this.sendTabsUpdate();
    this.sendGroupsUpdate();
    this.sendInitialStatusLine(id, cwd);

    if (cold) {
      this.coldTerminals.add(id);
      log('tab', `${id} restored cold (${engine}) in ${cwd}, group ${group.id}`);
      return id;
    }

    const config = this.engineConfig(engine);
    log('tab', `${id} created (${engine}) in ${cwd}, group ${group.id}`);
    this.spawnWhenMeasured(id, config, cwd);

    // Switch to the new tab
    this.postMessage({ type: 'switchTab', id });
    this.persistLayout();

    return id;
  }

  /**
   * Announces the tab in `presence.json` so other agents can discover and address it.
   *
   * Called right after every spawn — the router only fans a broadcast out to the tabs it finds
   * there, and a tab missing from the file is unreachable.
   */
  private registerPresence(terminalId: string): void {
    const instance = this.stateManager.get(terminalId);
    if (!instance) return;
    this.interAgentRouter?.registerPresence(terminalId, {
      engine: instance.engine,
      cwd: instance.cwd ?? '',
      cols: this.lastCols,
      rows: this.lastRows,
      ts: Date.now()
    });
  }

  // --- Group Management (Public API) ---

  /**
   * The group a new terminal belongs to. Creating the very first one asks for a working
   * directory exactly the way opening a tab always has, and takes its name and accent from the
   * engine that terminal runs.
   */
  private async ensureActiveGroup(engine: Engine): Promise<TerminalGroup> {
    const existing = this.stateManager.getActiveGroup();
    if (existing) {
      return existing;
    }
    return this.newGroup(engine);
  }

  /**
   * Creates a group with its own working directory and makes it active. It has no terminal yet —
   * every caller opens one straight after, which is what gives the group its first tab.
   */
  private async newGroup(engine: Engine): Promise<TerminalGroup> {
    const { path: cwd, folderIndex } = await this.ptyManager.selectWorkingDirectory(
      this.configManager.getConfig().cwd
    );
    const group = this.stateManager.createGroup(cwd, engine, folderIndex);
    this.stateManager.setActiveGroup(group.id);
    log('tab', `group ${group.id} created (${engine}) in ${cwd}`);
    this.sendGroupsUpdate();
    this.persistLayout();
    return group;
  }

  /**
   * The `+` in the group bar and the `claudeTerminal.newGroup` command: ask which CLI to run,
   * ask where, then open the group's first terminal there. The answer also names the group —
   * an OpenCode group reads `OpenCode 2`, not `Claude 2`.
   */
  public async promptAndCreateGroup(): Promise<void> {
    const engine = await this.promptForEngine();
    if (!engine) {
      return;
    }
    await this.newGroup(engine);
    await this.createTerminal(engine);
  }

  /**
   * Switches to another group: its remembered tab comes back, the inner tab bar is rebuilt for
   * it. Nothing is torn down — the other groups' terminals only stop being displayed, so their
   * xterm instances and scrollback survive.
   */
  public switchToGroup(groupId: string): void {
    const group = this.stateManager.getGroup(groupId);
    if (!group || this.stateManager.getActiveGroupId() === groupId) {
      return;
    }

    this.stateManager.setActiveGroup(groupId);
    const target = group.activeTerminalId ?? group.terminalIds[group.terminalIds.length - 1];
    if (target) {
      this.stateManager.setActive(target);
      this.postMessage({ type: 'switchTab', id: target });
      const instance = this.stateManager.get(target);
      if (instance) {
        this.startIfCold(target, instance);
      }
    }
    this.sendTabsUpdate();
    this.sendGroupsUpdate();
    this.persistLayout();
  }

  /**
   * Closes a group and every terminal in it. The last group stays: the panel is never without
   * one, the same way `handleReady` never leaves it without a tab.
   */
  public closeGroup(groupId: string): void {
    const group = this.stateManager.getGroup(groupId);
    if (!group) return;

    if (this.stateManager.groupCount <= 1) {
      return;
    }

    const wasActive = this.stateManager.getActiveGroupId() === groupId;
    for (const terminalId of [...group.terminalIds]) {
      this.disposeTerminal(terminalId);
    }
    this.stateManager.deleteGroup(groupId);
    log('tab', `group ${groupId} closed`);

    if (wasActive) {
      const next = this.stateManager.getActiveGroupId();
      const nextGroup = next ? this.stateManager.getGroup(next) : undefined;
      const target =
        nextGroup?.activeTerminalId ?? nextGroup?.terminalIds[nextGroup.terminalIds.length - 1];
      if (target) {
        this.stateManager.setActive(target);
        this.postMessage({ type: 'switchTab', id: target });
      } else {
        this.stateManager.clearActive();
      }
    }

    this.sendTabsUpdate();
    this.sendGroupsUpdate();
    this.persistLayout();
  }

  public closeActiveGroup(): void {
    const activeGroupId = this.stateManager.getActiveGroupId();
    if (activeGroupId) {
      this.closeGroup(activeGroupId);
    }
  }

  public switchToNextGroup(): void {
    this.cycleGroup(1);
  }

  public switchToPreviousGroup(): void {
    this.cycleGroup(-1);
  }

  private cycleGroup(step: number): void {
    const ids = this.stateManager.getAllGroupIds();
    if (ids.length <= 1) return;
    const currentIndex = ids.indexOf(this.stateManager.getActiveGroupId() ?? '');
    const nextIndex = (currentIndex + step + ids.length) % ids.length;
    this.switchToGroup(ids[nextIndex]);
  }

  /**
   * QuickPick behind the group bar's `+`: Claude Code or OpenCode. Asked once per group, and it
   * fixes that group's CLI, name and accent — every terminal opened in it runs the same one.
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
      title: 'New Terminal Tab',
      placeHolder: 'Choose the CLI this tab group runs'
    });

    return picked?.engine;
  }

  /**
   * Opens a tab running a specific command line rather than the engine's configured one.
   *
   * Only `createTerminalWithSessionFlag` reaches this now — the hand-typed custom command it was
   * also built for is gone, together with the rule it could break: a group runs one CLI, and a
   * freely typed command was the last way to put the other one inside it.
   */
  private async createTerminalWithCommand(command: string, args: string[]): Promise<string> {
    const id = this.stateManager.generateId();
    // Still derived rather than assumed: the caller passes the configured Claude command, which
    // the user may have pointed somewhere else.
    const engine: Engine =
      nodePath.basename(command).replace(/\.(exe|cmd|bat)$/i, '') === 'claude'
        ? 'claude'
        : 'opencode';
    const name = this.stateManager.generateName(engine);

    // Same rule as `createTerminal`: the group decides where this runs.
    const group = await this.ensureActiveGroup(engine);
    const cwd = group.cwd;

    const instance: TerminalInstance = {
      id,
      name,
      pty: undefined,
      isActive: false,
      workspaceFolderIndex: group.workspaceFolderIndex,
      cwd,
      engine,
      groupId: group.id
    };

    this.stateManager.set(id, instance);
    this.stateManager.setActive(id);

    const accentColor = this.getAccentColor(engine);
    this.postMessage({ type: 'createTab', id, name, accentColor, awaitingStart: true });
    this.sendTabsUpdate();
    this.sendGroupsUpdate();
    this.sendInitialStatusLine(id, cwd);

    // Use provided command/args instead of config
    const customConfig = { ...this.engineConfig(engine), command, args };
    log('tab', `${id} created (${engine}) in ${cwd} — ${[command, ...args].join(' ')}`);
    this.spawnWhenMeasured(id, customConfig, cwd);

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
  public async createTerminalWithSessionFlag(
    flag: '--continue' | '--resume'
  ): Promise<string | undefined> {
    const engine: Engine = 'claude';
    // These flags are Claude-only, so the tab would be a Claude tab — and a Claude tab has no
    // business in an OpenCode group. Refuse rather than break the group's one-CLI rule.
    const group = this.stateManager.getActiveGroup();
    if (group && group.engine !== engine) {
      void vscode.window.showInformationMessage(
        `Claude Terminal: ${flag} is Claude Code only, and “${group.name}” is an OpenCode tab group. Open a Claude tab group first.`
      );
      return undefined;
    }
    const config = this.engineConfig(engine);
    return this.createTerminalWithCommand(config.command, [...config.args, flag]);
  }

  /**
   * Kills a terminal and drops every trace of it, without deciding what becomes active next.
   * Split out so closing a whole group can reuse it — there, picking a successor per terminal
   * would only fight the group switch that follows.
   */
  private disposeTerminal(terminalId: string): void {
    const pending = this.pendingSpawns.get(terminalId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingSpawns.delete(terminalId);
    }

    log('tab', `${terminalId} closed`);
    this.ptyManager.kill(terminalId);
    this.promptDetector.removeTerminal(terminalId);
    this.statusLineWatcher.removeTerminal(terminalId);
    this.thresholdNotified.delete(terminalId);
    this.coldTerminals.delete(terminalId);
    this.interAgentRouter?.unregisterPresence(terminalId);
    this.stateManager.delete(terminalId);
    this.postMessage({ type: 'removeTab', id: terminalId });
  }

  public closeTerminal(terminalId: string): void {
    const instance = this.stateManager.get(terminalId);
    if (!instance) return;

    const groupId = instance.groupId;
    const wasActive = this.stateManager.getActiveId() === terminalId;
    this.disposeTerminal(terminalId);

    // A group with no terminals left has nothing to show. It goes with its last tab — unless it
    // is the only group, which stays and gets a fresh terminal instead, so the panel is never
    // empty.
    const group = this.stateManager.getGroup(groupId);
    if (group && group.terminalIds.length === 0) {
      if (this.stateManager.groupCount > 1) {
        this.closeGroup(groupId);
      } else {
        this.stateManager.clearActive();
        this.sendGroupsUpdate();
        void this.createTerminal();
      }
      return;
    }

    if (wasActive) {
      this.handleActiveTerminalClosed();
      return;
    }

    this.sendTabsUpdate();
    this.sendGroupsUpdate();
    this.persistLayout();
  }

  /**
   * Picks the successor inside the closed tab's own group — never a terminal from another one,
   * which would silently move the user to a different working directory.
   */
  private handleActiveTerminalClosed(): void {
    const remaining = this.stateManager.getGroupTerminals();
    if (remaining.length > 0) {
      const newActive = remaining[remaining.length - 1];
      this.switchToTerminal(newActive.id);
      return;
    }
    this.stateManager.clearActive();
    void this.createTerminal();
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
    this.startIfCold(terminalId, instance);
    this.sendTabsUpdate();
    // Activating a tab of another group activates that group too.
    this.sendGroupsUpdate();
    this.persistLayout();
  }

  /**
   * A restored tab starts its process the first time it is actually looked at.
   *
   * It goes through `spawnWhenMeasured` like any other tab rather than spawning straight away:
   * the webview reports `terminalReady` only once per tab, so `startTerminal` tells it to measure
   * and report again. That keeps the one rule that matters — a process learns its window size
   * before it paints its first frame.
   */
  private startIfCold(terminalId: string, instance: TerminalInstance): void {
    if (!this.coldTerminals.delete(terminalId)) {
      return;
    }
    log('tab', `${terminalId} woken, starting process`);
    this.spawnWhenMeasured(terminalId, this.engineConfig(instance.engine), instance.cwd);
    this.postMessage({ type: 'startTerminal', id: terminalId });
  }

  /** Cycles within the active group only — the shortcut must not jump to another directory. */
  public switchToNextTerminal(): void {
    this.cycleTerminal(1);
  }

  public switchToPreviousTerminal(): void {
    this.cycleTerminal(-1);
  }

  private cycleTerminal(step: number): void {
    const ids = this.stateManager.getGroupTerminals().map((t) => t.id);
    if (ids.length <= 1) return;

    const currentIndex = ids.indexOf(this.stateManager.getActiveId() ?? '');
    const nextIndex = (currentIndex + step + ids.length) % ids.length;
    this.switchToTerminal(ids[nextIndex]);
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

    this.thresholdNotified.delete(activeId);
    // Restart/resume/continue start the process outright, so the tab is no longer cold.
    this.coldTerminals.delete(activeId);

    // No guard flag needed for the old process: `PtyManager` drops it from its map here, and
    // both its handlers check that identity before reporting anything.
    this.ptyManager.kill(activeId);

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
    this.ptyManager.spawn(activeId, spawnConfig, this.lastCols, this.lastRows, cwd);
    this.registerPresence(activeId);
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
    for (const pending of this.pendingSpawns.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingSpawns.clear();
    this.themeSubscription.dispose();
    this.ptyManager.killAll();
    this.interAgentRouter?.dispose();
    this.promptDetector.dispose();
    this.statusLineWatcher.dispose();
    this.editorTracker.dispose();
    this.configManager.dispose();
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
    // A tab waiting for input in a group that is not on screen would otherwise be invisible —
    // its pill has nowhere to sit. The group tab carries it instead.
    this.sendGroupsUpdate();
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

  private sendGroupsUpdate(): void {
    const groups = this.stateManager.getGroupsInfo();
    this.postMessage({ type: 'groupsUpdate', groups });
  }

  /**
   * Writes the current groups to `workspaceState`.
   *
   * Called from the structural changes only — creating, closing, renaming and switching — not from
   * `sendGroupsUpdate`, which also fires whenever a tab starts or stops waiting for input and would
   * turn a prompt flicker into a disk write.
   */
  private persistLayout(): void {
    if (!this.workspaceState) return;

    const activeGroupId = this.stateManager.getActiveGroupId();
    const groups = this.stateManager.getAllGroups();
    const layout: PersistedLayout = {
      version: 1,
      activeGroupIndex: Math.max(
        0,
        groups.findIndex((g) => g.id === activeGroupId)
      ),
      groups: groups.map((g) => ({
        name: g.name,
        cwd: g.cwd,
        engine: g.engine,
        workspaceFolderIndex: g.workspaceFolderIndex,
        terminalCount: g.terminalIds.length,
        activeTerminalIndex: Math.max(
          0,
          g.terminalIds.indexOf(g.activeTerminalId ?? g.terminalIds[0])
        )
      }))
    };
    void this.workspaceState.update(ClaudeTerminalViewProvider.LAYOUT_KEY, layout);
  }

  /**
   * The remembered layout, or undefined when there is none or it does not hold up.
   *
   * Read as `unknown` and narrowed field by field on purpose: this comes off disk, where it may
   * have been written by an older shape of the extension or edited by hand. Trusting the type
   * parameter here would let a stale entry spawn terminals from garbage.
   */
  private readLayout(): PersistedLayout | undefined {
    const stored: unknown = this.workspaceState?.get(ClaudeTerminalViewProvider.LAYOUT_KEY);
    if (typeof stored !== 'object' || stored === null) {
      return undefined;
    }
    const record = stored as Record<string, unknown>;
    if (record.version !== 1 || !Array.isArray(record.groups)) {
      return undefined;
    }

    const groups: PersistedGroup[] = [];
    for (const entry of record.groups as unknown[]) {
      if (typeof entry !== 'object' || entry === null) continue;
      const g = entry as Record<string, unknown>;
      if (
        typeof g.cwd !== 'string' ||
        typeof g.name !== 'string' ||
        (g.engine !== 'claude' && g.engine !== 'opencode') ||
        typeof g.terminalCount !== 'number' ||
        !Number.isInteger(g.terminalCount) ||
        g.terminalCount < 1
      ) {
        continue;
      }
      groups.push({
        name: g.name,
        cwd: g.cwd,
        engine: g.engine,
        workspaceFolderIndex:
          typeof g.workspaceFolderIndex === 'number' ? g.workspaceFolderIndex : undefined,
        // A tab count in the thousands would be a corrupt entry, not a layout worth honouring.
        terminalCount: Math.min(g.terminalCount, ClaudeTerminalViewProvider.MAX_RESTORED_TABS),
        activeTerminalIndex:
          typeof g.activeTerminalIndex === 'number' && Number.isInteger(g.activeTerminalIndex)
            ? g.activeTerminalIndex
            : 0
      });
    }
    if (groups.length === 0) {
      return undefined;
    }

    return {
      version: 1,
      groups,
      activeGroupIndex: typeof record.activeGroupIndex === 'number' ? record.activeGroupIndex : 0
    };
  }

  /**
   * Rebuilds the remembered groups after a window reload. Everything comes back cold except the
   * one tab that was on screen — the processes died with the extension host, and starting one CLI
   * session per restored tab is a cost the user never asked for.
   *
   * A group whose directory has since disappeared is dropped rather than spawned in a path that
   * no longer exists.
   */
  private async restoreOrCreate(): Promise<void> {
    const layout = this.readLayout();
    if (layout && (await this.restoreLayout(layout))) {
      return;
    }
    await this.createTerminal();
  }

  private async restoreLayout(layout: PersistedLayout): Promise<boolean> {
    const wanted = layout.groups.filter((g) => existsSync(g.cwd));
    if (wanted.length === 0) {
      return false;
    }

    const activeIndex = Math.min(Math.max(layout.activeGroupIndex, 0), wanted.length - 1);
    let activeTerminalId: string | undefined;

    for (const [index, saved] of wanted.entries()) {
      const group = this.stateManager.createGroup(
        saved.cwd,
        saved.engine,
        saved.workspaceFolderIndex
      );
      this.stateManager.renameGroup(group.id, saved.name);
      this.stateManager.setActiveGroup(group.id);

      const activeTab = Math.min(Math.max(saved.activeTerminalIndex, 0), saved.terminalCount - 1);
      for (let tab = 0; tab < saved.terminalCount; tab++) {
        const id = await this.createTerminal(saved.engine, true);
        if (index === activeIndex && tab === activeTab) {
          activeTerminalId = id;
        }
      }
    }

    log(
      'tab',
      `restored ${String(wanted.length)} group(s) from workspaceState, all tabs cold except one`
    );

    this.sendGroupsUpdate();
    this.sendTabsUpdate();
    if (activeTerminalId) {
      // The one tab on screen is worth a process: this goes through `switchToTerminal`, which
      // wakes it exactly the way clicking any other restored tab would.
      this.switchToTerminal(activeTerminalId);
    }
    return true;
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
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <link href="${xtermCssUri.toString()}" rel="stylesheet">
    <link href="${stylesUri.toString()}" rel="stylesheet">
</head>
<body>
    <div id="group-bar"></div>
    <div id="body-row">
        <div id="terminal-column">
            <div id="terminals-container"></div>
            <div id="status-line" hidden></div>
        </div>
        <div id="tab-bar"></div>
    </div>
    <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }

  private getNonce(): string {
    return randomBytes(24).toString('base64url');
  }
}
