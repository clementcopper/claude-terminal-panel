// node-pty types
export interface IPty {
  /** The child's process id — only ever used for the diagnostic log. */
  readonly pid: number;
  onData: (callback: (data: string) => void) => void;
  onExit: (callback: (exitCode: { exitCode: number; signal?: number }) => void) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
}

export interface INodePty {
  spawn: (
    file: string,
    args: string[],
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string | undefined>;
    }
  ) => IPty;
}

/**
 * The CLI agent a tab runs. Claude Code is the default; OpenCode is the alternative
 * the user picks when opening a new tab. Session flags and the status line are
 * Claude-specific.
 */
export type Engine = 'claude' | 'opencode';

/**
 * The accent line colour for a tab, keyed by engine. Claude Code uses Anthropic's orange;
 * OpenCode uses the accent purple of its terminal UI (the opencode.ai logo itself is
 * monochrome, so the violet is the one its TUI draws).
 */
export const ENGINE_ACCENT_COLORS: Record<Engine, string> = {
  claude: '#d97757',
  opencode: '#9d7cd8'
};

// Configuration
export interface TerminalConfig {
  command: string;
  /** Command for an OpenCode tab; what `+` → OpenCode spawns. */
  opencodeCommand: string;
  args: string[];
  autoRun: boolean;
  shell: string;
  env: Record<string, string>;
  directMode: boolean;
  /** Fixed working directory. Empty means: use the workspace folder. */
  cwd: string;
  /** Render the statusLine script's data at the bottom of the panel. */
  statusLine: boolean;
  /**
   * `bundled` injects the shipped producer per session through `claude --settings`;
   * `own` expects the user's own statusLine command to write the snapshot.
   */
  statusLineProvider: 'bundled' | 'own';
  /** Target number of compactions shown next to the counter; 0 hides the budget. */
  statusLineCompactBudget: number;
  /** Show the open file, and any selected lines, at the top of the status line. */
  editorContext: boolean;
  /** Percentage of the context window at which the status line warns that a `/clear` is due. */
  contextThreshold: number;
}

/**
 * What the statusLine script writes per tab. Its own flat schema, not Claude Code's stdin
 * payload — the script keeps the arithmetic (real percentage, compact counting), so a schema
 * change on Claude's side lands in one place.
 */
export interface StatusLineSnapshot {
  model: string;
  /** Effort level plus fast mode, e.g. `high · fast` — empty when Claude reports neither. */
  effort?: string;
  /** Working directory with `~` already collapsed by the script. */
  cwd?: string;
  usedTokens: number;
  totalTokens: number;
  usedPercent: number;
  sessionPercent?: number;
  /** Unix seconds. Survives being remembered; the minutes below are derived and go stale. */
  sessionResetsAt?: number;
  sessionResetsInMin?: number;
  weekPercent?: number;
  weekResetsAt?: string;
  compacted?: number;
  compactBudget?: number;
  compactAuto?: number;
  /** Unix seconds, so the webview can grey out a stale line. */
  updatedAt: number;
}

/**
 * What the editor is looking at. Belongs to the window, not to a tab — there is one active
 * editor, however many terminals are open.
 */
export interface EditorContext {
  /** Shown in the status line; the path is too wide for a sidebar. */
  fileName: string;
  /** Workspace-relative where possible, absolute otherwise. This is what a reference carries. */
  relativePath: string;
  /** 1-based, and only present when something is actually selected. */
  startLine?: number;
  endLine?: number;
}

// Terminal instance for multi-tab support
export interface TerminalInstance {
  id: string;
  name: string;
  pty: IPty | undefined;
  isActive: boolean;
  workspaceFolderIndex?: number;
  isWaitingForInput?: boolean;
  cwd?: string;
  /** Which CLI agent this tab runs; drives restart/resume/continue. */
  engine: Engine;
  /** The group this tab belongs to. Groups own the working directory; tabs inherit it. */
  groupId: string;
}

/**
 * The outer tab level: a group of terminals sharing one working directory.
 *
 * Terminal ids stay globally unique across groups on purpose — they key `PtyManager.ptys`, the
 * status line's `<terminalId>.json`, `MY_TAB_ID` in the PTY env, the inter-agent presence file
 * and the webview's `#terminal-<id>`. Grouping sits on top of all that and none of those
 * contracts had to learn about it.
 */
export interface TerminalGroup {
  id: string;
  name: string;
  /** Every terminal opened in this group starts here. Session history lives per directory. */
  cwd: string;
  workspaceFolderIndex?: number;
  /**
   * The CLI the group was opened for. It fixes the group's name and accent bar; the inner `+`
   * can still open a tab of the other engine inside it, which does not rename the group.
   */
  engine: Engine;
  /** Tab order within the group. */
  terminalIds: string[];
  /** Which tab to return to when the group is activated again. */
  activeTerminalId?: string;
}

/**
 * The tab layout as it is written to `workspaceState`, so a window reload comes back to the same
 * groups. Only the shape survives — the processes die with the extension host, so there is no
 * scrollback and no session to restore, and every terminal comes back cold.
 *
 * Deliberately index-based and free of ids: ids are minted per run and mean nothing across one.
 */
export interface PersistedGroup {
  name: string;
  cwd: string;
  engine: Engine;
  workspaceFolderIndex?: number;
  /** How many terminals the group had. Each comes back as one cold tab. */
  terminalCount: number;
  /** Which of them was on screen, as an index into that count. */
  activeTerminalIndex: number;
}

export interface PersistedLayout {
  /** Bumped when the shape changes; an unknown version is discarded rather than guessed at. */
  version: 1;
  groups: PersistedGroup[];
  activeGroupIndex: number;
}

// Group information for the UI's outer tab bar
export interface GroupInfo {
  id: string;
  name: string;
  isActive: boolean;
  cwd: string;
  terminalCount: number;
  /** Any terminal in the group waiting for input — the group tab shows a pill for it. */
  hasWaitingTerminal: boolean;
  engine: Engine;
  accentColor?: string;
}

// Tab information for UI
export interface TabInfo {
  id: string;
  name: string;
  isActive: boolean;
  accentColor?: string;
  isWaitingForInput?: boolean;
  /** Working directory of the terminal — shown as the tab tooltip. */
  cwd?: string;
  /** Which CLI agent this tab runs. */
  engine: Engine;
}

// Webview message types (from webview to extension)
export type WebviewMessage =
  | { type: 'ready'; cols?: number; rows?: number }
  | { type: 'input'; id: string; data: string }
  | { type: 'resize'; id: string; cols: number; rows: number }
  /**
   * The webview has opened, measured and fitted the tab's terminal. The PTY is started from
   * this, not from an estimate: before the element has a box, xterm sits at its default 80x24
   * and the process would paint its first frame for a window that does not exist.
   */
  | { type: 'terminalReady'; id: string; cols: number; rows: number }
  | { type: 'newTab' }
  | { type: 'closeTab'; id: string }
  | { type: 'switchTab'; id: string }
  /** The `+` in the group bar: a new group, with its own working directory. */
  | { type: 'newGroup' }
  | { type: 'closeGroup'; id: string }
  | { type: 'switchGroup'; id: string }
  /** Inline rename from the group tab. An empty or unchanged name is dropped by the host. */
  | { type: 'renameGroup'; id: string; name: string }
  | { type: 'openFile'; id: string; path: string; line?: number; column?: number }
  // A web link in the terminal output. Opened by the host so VS Code's own trusted-domains
  // prompt applies — the output is model-generated, so no link opens straight from the webview.
  | { type: 'openExternal'; uri: string }
  // No tab id: the reference goes to whichever tab is active when it is asked for
  | { type: 'insertEditorReference' }
  /**
   * A closed set of actions rather than a general "write this to the PTY": the webview renders
   * model-generated output, and a channel from there into the terminal has to stay a command,
   * not a keyboard.
   */
  | { type: 'stopTurn'; id: string }
  // The slider on the context bar; the value is written back to the workspace settings
  | { type: 'setContextThreshold'; value: number }
  | { type: 'promptContextThreshold' }
  /**
   * The webview just re-applied its xterm theme after a VS Code colour-theme change. This is the
   * point in time (after the new background is live in xterm) at which OpenCode tabs can safely be
   * poked to re-resolve their theme — poking earlier races the 50 ms sample delay in the webview.
   */
  | { type: 'themeApplied' };

// Extension message types (from extension to webview)
export type ExtensionMessage =
  | { type: 'output'; id: string; data: string }
  | { type: 'clear'; id: string }
  /** Only the active group's tabs — the inner bar never shows another group's terminals. */
  | { type: 'tabsUpdate'; tabs: TabInfo[] }
  | { type: 'groupsUpdate'; groups: GroupInfo[] }
  /**
   * `awaitingStart` distinguishes a brand new tab from one being restored after the webview was
   * rebuilt: only the new one has a process that has yet to print anything, and only there is a
   * "starting…" indicator the truth. A restored tab hangs on a process that may simply be idle.
   */
  | {
      type: 'createTab';
      id: string;
      name: string;
      accentColor?: string;
      awaitingStart: boolean;
    }
  | { type: 'switchTab'; id: string }
  /**
   * Wake a restored tab that has never run: re-measure it and report `terminalReady` again, which
   * is what starts its process. The webview reports ready only once per tab, so without this a
   * cold tab could never ask for its own process.
   */
  | { type: 'startTerminal'; id: string }
  | { type: 'removeTab'; id: string }
  | { type: 'setNotification'; id: string; show: boolean }
  | { type: 'statusLine'; id: string; data: StatusLineSnapshot | null }
  | { type: 'editorContext'; data: EditorContext | null }
  | { type: 'focusTerminal' }
  // The threshold lives in the settings; the webview only draws and drags it
  | { type: 'contextThreshold'; value: number };

// Command help parsing types
export interface CommandFlag {
  flag: string;
  shortFlag?: string;
  description: string;
  takesValue?: boolean;
  valueHint?: string;
  repeatable?: boolean;
}

export interface ParsedHelp {
  command: string;
  flags: CommandFlag[];
  subcommands?: string[];
  parseErrors?: string[];
}

// Path autocomplete types
export type PathFilterMode = 'all' | 'files' | 'directories';

export interface PathSuggestion {
  /** Display name (e.g., "package.json") */
  name: string;
  /** Full path to suggest (relative or absolute) */
  path: string;
  /** Whether this is a directory */
  isDirectory: boolean;
}

export interface PathContext {
  /** Whether we're in path completion mode */
  active: boolean;
  /** The partial path typed so far (e.g., "src/comp") */
  partialPath: string;
  /** Filter mode based on valueHint */
  filterMode: PathFilterMode;
  /** Whether to show absolute paths (user typed leading /) */
  isAbsolute: boolean;
  /** The flag being completed */
  flag: CommandFlag;
}
