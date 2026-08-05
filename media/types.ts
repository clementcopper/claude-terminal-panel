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

// Message types from extension to webview
export type WebviewIncomingMessage =
  | { type: 'output'; id: string; data: string }
  | { type: 'clear'; id: string }
  | { type: 'tabsUpdate'; tabs: TabInfo[] }
  | { type: 'createTab'; id: string; name: string; accentColor?: string }
  | { type: 'switchTab'; id: string }
  | { type: 'removeTab'; id: string }
  | { type: 'setNotification'; id: string; show: boolean }
  | { type: 'statusLine'; id: string; data: StatusLineSnapshot | null };

// Message types from webview to extension
export type WebviewOutgoingMessage =
  | { type: 'ready'; cols: number; rows: number }
  | { type: 'input'; id: string; data: string }
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'newTab' }
  | { type: 'newTabWithCommand' }
  | { type: 'closeTab'; id: string }
  | { type: 'switchTab'; id: string }
  | { type: 'openFile'; id: string; path: string; line?: number; column?: number };

// Terminal entry in the map
export interface TerminalEntry {
  terminal: XTermTerminal;
  fitAddon: XTermFitAddon;
  element: HTMLDivElement;
  isAtBottom: boolean;
  lastScrollTop: number;
}

// xterm.js theme type (re-export for convenience)
export type XTermTheme = ITheme;
