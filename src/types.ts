// Muted but distinct workspace accent colors
export const WORKSPACE_ACCENT_COLORS = [
  '#6b9ac4', // Muted blue
  '#82b366', // Muted green
  '#c4a46b', // Muted gold
  '#b36b82', // Muted rose
  '#9b82b3', // Muted purple
  '#6bc4b3', // Muted teal
  '#c47a6b', // Muted coral
  '#7a8c9e' // Muted steel
] as const;

// node-pty types
export interface IPty {
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

// Configuration
export interface TerminalConfig {
  command: string;
  args: string[];
  autoRun: boolean;
  shell: string;
  env: Record<string, string>;
  directMode: boolean;
  /** Fixed working directory. Empty means: use the workspace folder. */
  cwd: string;
  /** Probe other CLI agents for --help output on startup. */
  preloadHelp: boolean;
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
}

// Webview message types (from webview to extension)
export type WebviewMessage =
  | { type: 'ready'; cols?: number; rows?: number }
  | { type: 'input'; id: string; data: string }
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'newTab' }
  | { type: 'newTabWithCommand' }
  | { type: 'closeTab'; id: string }
  | { type: 'switchTab'; id: string }
  | { type: 'openFile'; id: string; path: string; line?: number; column?: number }
  // No tab id: the reference goes to whichever tab is active when it is asked for
  | { type: 'insertEditorReference' };

// Extension message types (from extension to webview)
export type ExtensionMessage =
  | { type: 'output'; id: string; data: string }
  | { type: 'clear'; id: string }
  | { type: 'tabsUpdate'; tabs: TabInfo[] }
  | { type: 'createTab'; id: string; name: string; accentColor?: string }
  | { type: 'switchTab'; id: string }
  | { type: 'removeTab'; id: string }
  | { type: 'setNotification'; id: string; show: boolean }
  | { type: 'statusLine'; id: string; data: StatusLineSnapshot | null }
  | { type: 'editorContext'; data: EditorContext | null }
  | { type: 'focusTerminal' };

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
