import type { Terminal as XTermTerminal, ITheme } from '@xterm/xterm';
import type { FitAddon as XTermFitAddon } from '@xterm/addon-fit';

// VS Code API types for webview
export interface VSCodeAPI {
  postMessage(message: WebviewOutgoingMessage): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
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
  engine?: 'claude' | 'opencode';
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
  compacted?: number;
  compactBudget?: number;
  compactAuto?: number;
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

// Message types from extension to webview
export type WebviewIncomingMessage =
  | { type: 'output'; id: string; data: string }
  | { type: 'clear'; id: string }
  | { type: 'tabsUpdate'; tabs: TabInfo[] }
  | {
      type: 'createTab';
      id: string;
      name: string;
      accentColor?: string;
      awaitingStart: boolean;
    }
  | { type: 'switchTab'; id: string }
  | { type: 'removeTab'; id: string }
  | { type: 'setNotification'; id: string; show: boolean }
  | { type: 'statusLine'; id: string; data: StatusLineSnapshot | null }
  | { type: 'editorContext'; data: EditorContext | null }
  | { type: 'focusTerminal' }
  | { type: 'contextThreshold'; value: number };

// Message types from webview to extension
export type WebviewOutgoingMessage =
  | { type: 'ready'; cols: number; rows: number }
  | { type: 'input'; id: string; data: string }
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'terminalReady'; id: string; cols: number; rows: number }
  | { type: 'newTab' }
  | { type: 'newTabWithCommand' }
  | { type: 'closeTab'; id: string }
  | { type: 'switchTab'; id: string }
  | { type: 'openFile'; id: string; path: string; line?: number; column?: number }
  | { type: 'insertEditorReference' }
  | { type: 'stopTurn'; id: string }
  | { type: 'setContextThreshold'; value: number }
  | { type: 'promptContextThreshold' }
  | { type: 'themeApplied' };

// Terminal entry in the map
export interface TerminalEntry {
  terminal: XTermTerminal;
  fitAddon: XTermFitAddon;
  element: HTMLDivElement;
  isAtBottom: boolean;
  lastScrollTop: number;
  /** Set once `terminalReady` has been sent for this tab; the host starts the process on it. */
  readySent?: boolean;
  /** The "starting…" indicator and its two timers, all cleared on the first byte of output. */
  startupIndicator?: HTMLElement;
  startupShowTimer?: number;
  startupTickTimer?: number;
  /** Pending report, restarted by every fit until the size stops moving. */
  readyTimer?: number;
}

// xterm.js theme type (re-export for convenience)
export type XTermTheme = ITheme;
