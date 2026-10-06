import type { Terminal as XTermTerminal, ITheme } from '@xterm/xterm';
import type { FitAddon as XTermFitAddon } from '@xterm/addon-fit';

// VS Code API types for webview
export interface VSCodeAPI {
  postMessage(message: WebviewOutgoingMessage): void;
}

// Global declarations for VSCode webview API
declare global {
  function acquireVsCodeApi(): VSCodeAPI;
}

// Tab information
export interface TabInfo {
  id: string;
  name: string;
  isActive: boolean;
  accentColor?: string;
  isWaitingForInput?: boolean;
  cwd?: string;
  engine: 'claude' | 'opencode';
}

/**
 * Status line data for one tab, produced by the statusLine script.
 * Declared separately from `src/types.ts` on purpose — the two bundles share no module.
 */
export interface StatusLineSnapshot {
  model: string;
  effort?: string;
  cwd?: string;
  usedTokens: number;
  totalTokens: number;
  usedPercent: number;
  sessionPercent?: number;
  sessionResetsAt?: number;
  sessionResetsInMin?: number;
  weekPercent?: number;
  weekResetsAt?: string;
  /**
   * Set when the week ring shows a model's own weekly window instead of the account-wide one —
   * the server's label, e.g. `Fable`. Absent for every model without its own window.
   */
  weekScope?: string;
  /** The account-wide weekly percentage `weekPercent` replaced; only set with `weekScope`. */
  weekAllPercent?: number;
  compacted?: number;
  compactBudget?: number;
  compactAuto?: number;
  /**
   * Live fields, written by the `panel-bridge` mod inside the Claude process and merged over the
   * producer's snapshot by the watcher. All optional: an older Claude Code, another CLI or a tab
   * whose session has not written yet carries none of them, and the row falls back to the
   * producer's values.
   */
  /** `busy` while a turn runs, `asking` while a permission dialog or question waits, else `idle`. */
  state?: 'idle' | 'busy' | 'asking';
  /** Unix milliseconds the state last changed — compared with the last user input to decide the pill. */
  stateAt?: number;
  /** The main-thread tool running right now, with a few words from its arguments. */
  tool?: { name: string; summary: string };
  /** Subagents running at the moment. */
  agents?: number;
  /**
   * Session cost as `/cost` totals it — API list prices, so on a subscription it is what the
   * tokens would have cost, not a bill. Carried, not drawn (Daniel's call, 2026-10-06).
   */
  costUsd?: number;
  /** Which model request of the turn the token figures came from (0-based). */
  stepIndex?: number;
  /** The model id the last request named (`claude-fable-5-1`); `model` keeps the display name. */
  modelId?: string;
  /** Unix milliseconds of the live write the token figures came from; absent when they are the producer's. */
  liveAt?: number;
  /** Unix seconds, as the producer writes it — multiply by 1000 before comparing with Date.now(). */
  updatedAt: number;
}

/**
 * The file the editor is showing, and the lines selected in it. Same separate declaration as
 * `StatusLineSnapshot` above, for the same reason.
 */
export interface EditorContext {
  fileName: string;
  relativePath: string;
  startLine?: number;
  endLine?: number;
}

/**
 * One outer tab: a group of terminals sharing a working directory. Separate declaration from
 * `src/types.ts` for the same reason as everything else here — the two bundles share no module.
 */
export interface GroupInfo {
  id: string;
  name: string;
  isActive: boolean;
  cwd: string;
  terminalCount: number;
  hasWaitingTerminal: boolean;
  engine: 'claude' | 'opencode';
  accentColor?: string;
}

// Message types from extension to webview
export type WebviewIncomingMessage =
  | { type: 'output'; id: string; data: string }
  | { type: 'clear'; id: string }
  | { type: 'tabsUpdate'; tabs: TabInfo[] }
  | { type: 'groupsUpdate'; groups: GroupInfo[] }
  | {
      type: 'createTab';
      id: string;
      name: string;
      awaitingStart: boolean;
    }
  | { type: 'switchTab'; id: string; focus?: boolean }
  | { type: 'startTerminal'; id: string }
  | { type: 'removeTab'; id: string }
  | { type: 'setNotification'; id: string; show: boolean }
  | { type: 'statusLine'; id: string; data: StatusLineSnapshot | null }
  | { type: 'editorContext'; data: EditorContext | null }
  | { type: 'focusTerminal' }
  | { type: 'pasteText'; id: string; text: string }
  | { type: 'contextThreshold'; value: number };

/** One dropped file: its name and its bytes as base64. Mirror of `DroppedFile` in `src/types.ts`. */
export interface DroppedFile {
  name: string;
  data: string;
}

// Message types from webview to extension
export type WebviewOutgoingMessage =
  | { type: 'ready'; cols: number; rows: number }
  | { type: 'input'; id: string; data: string }
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'terminalReady'; id: string; cols: number; rows: number }
  | { type: 'newTab' }
  | { type: 'closeTab'; id: string }
  | { type: 'switchTab'; id: string }
  | { type: 'newGroup' }
  | { type: 'closeGroup'; id: string }
  | { type: 'switchGroup'; id: string }
  | { type: 'renameGroup'; id: string; name: string }
  | { type: 'openFile'; id: string; path: string; line?: number; column?: number }
  | { type: 'openExternal'; uri: string }
  | { type: 'insertEditorReference' }
  | { type: 'stopTurn'; id: string }
  | { type: 'pasteRequest'; id: string }
  | { type: 'dropFiles'; id: string; files: DroppedFile[] }
  | { type: 'promptContextThreshold' }
  | { type: 'themeApplied' };

// Terminal entry in the map
export interface TerminalEntry {
  terminal: XTermTerminal;
  fitAddon: XTermFitAddon;
  element: HTMLDivElement;
  /** Set once `terminalReady` has been sent for this tab; the host starts the process on it. */
  readySent?: boolean;
  /** Kept for the startup indicator a restored tab shows when it is finally woken. */
  name?: string;
  /** The "starting…" indicator and its two timers, all cleared on the first byte of output. */
  startupIndicator?: HTMLElement;
  startupShowTimer?: number;
  startupTickTimer?: number;
  /** Pending report, restarted by every fit until the size stops moving. */
  readyTimer?: number;
}

// xterm.js theme type (re-export for convenience)
export type XTermTheme = ITheme;
