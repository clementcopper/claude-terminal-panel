import type { WebviewMessage } from './types';

/**
 * Context interface that message handlers use to perform actions.
 * Implemented by ClaudeTerminalViewProvider.
 */
export interface MessageHandlerContext {
  handleReady(cols: number, rows: number): void;
  handleInput(id: string, data: string): void;
  handleResize(id: string, cols: number, rows: number): void;
  handleTerminalReady(id: string, cols: number, rows: number): void;
  handleNewTab(): void;
  handleCloseTab(id: string): void;
  handleSwitchTab(id: string): void;
  handleNewGroup(): void;
  handleCloseGroup(id: string): void;
  handleSwitchGroup(id: string): void;
  handleRenameGroup(id: string, name: string): void;
  handleOpenFile(id: string, path: string, line?: number, column?: number): void;
  handleOpenExternal(uri: string): void;
  handleInsertEditorReference(): void;
  handleStopTurn(id: string): void;
  handleSetContextThreshold(value: number): void;
  handlePromptContextThreshold(): void;
  handleThemeApplied(): void;
}

type MessageHandler<T extends WebviewMessage> = (message: T, ctx: MessageHandlerContext) => void;

type MessageHandlerMap = {
  [K in WebviewMessage['type']]: MessageHandler<Extract<WebviewMessage, { type: K }>>;
};

/**
 * Registry of message handlers.
 * Replaces the switch statement with a typed handler map.
 */
const messageHandlers: MessageHandlerMap = {
  ready: (message, ctx) => {
    ctx.handleReady(message.cols ?? 80, message.rows ?? 24);
  },
  input: (message, ctx) => {
    ctx.handleInput(message.id, message.data);
  },
  resize: (message, ctx) => {
    ctx.handleResize(message.id, message.cols, message.rows);
  },
  terminalReady: (message, ctx) => {
    ctx.handleTerminalReady(message.id, message.cols, message.rows);
  },
  newTab: (_message, ctx) => {
    ctx.handleNewTab();
  },
  closeTab: (message, ctx) => {
    ctx.handleCloseTab(message.id);
  },
  switchTab: (message, ctx) => {
    ctx.handleSwitchTab(message.id);
  },
  newGroup: (_message, ctx) => {
    ctx.handleNewGroup();
  },
  closeGroup: (message, ctx) => {
    ctx.handleCloseGroup(message.id);
  },
  switchGroup: (message, ctx) => {
    ctx.handleSwitchGroup(message.id);
  },
  renameGroup: (message, ctx) => {
    ctx.handleRenameGroup(message.id, message.name);
  },
  openFile: (message, ctx) => {
    ctx.handleOpenFile(message.id, message.path, message.line, message.column);
  },
  openExternal: (message, ctx) => {
    ctx.handleOpenExternal(message.uri);
  },
  insertEditorReference: (_message, ctx) => {
    ctx.handleInsertEditorReference();
  },
  stopTurn: (message, ctx) => {
    ctx.handleStopTurn(message.id);
  },
  setContextThreshold: (message, ctx) => {
    ctx.handleSetContextThreshold(message.value);
  },
  promptContextThreshold: (_message, ctx) => {
    ctx.handlePromptContextThreshold();
  },
  themeApplied: (_message, ctx) => {
    ctx.handleThemeApplied();
  }
};

/**
 * Dispatches a message to its appropriate handler.
 */
export function dispatchMessage(message: WebviewMessage, ctx: MessageHandlerContext): void {
  const handler = messageHandlers[message.type] as MessageHandler<typeof message> | undefined;
  // The map is exhaustive by construction, so this can only be a message type the running webview
  // knows and this build does not — a stale webview after an update. Dropping it beats throwing.
  if (!handler) {
    return;
  }
  handler(message, ctx);
}
