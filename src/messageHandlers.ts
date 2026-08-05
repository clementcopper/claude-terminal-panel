import type { WebviewMessage } from './types';

/**
 * Context interface that message handlers use to perform actions.
 * Implemented by ClaudeTerminalViewProvider.
 */
export interface MessageHandlerContext {
  handleReady(cols: number, rows: number): void;
  handleInput(id: string, data: string): void;
  handleResize(id: string, cols: number, rows: number): void;
  handleNewTab(): void;
  handleNewTabWithCommand(): void;
  handleCloseTab(id: string): void;
  handleSwitchTab(id: string): void;
  handleOpenFile(id: string, path: string, line?: number, column?: number): void;
  handleInsertEditorReference(): void;
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
  newTab: (_message, ctx) => {
    ctx.handleNewTab();
  },
  newTabWithCommand: (_message, ctx) => {
    ctx.handleNewTabWithCommand();
  },
  closeTab: (message, ctx) => {
    ctx.handleCloseTab(message.id);
  },
  switchTab: (message, ctx) => {
    ctx.handleSwitchTab(message.id);
  },
  openFile: (message, ctx) => {
    ctx.handleOpenFile(message.id, message.path, message.line, message.column);
  },
  insertEditorReference: (_message, ctx) => {
    ctx.handleInsertEditorReference();
  }
};

/**
 * Dispatches a message to its appropriate handler.
 */
export function dispatchMessage(message: WebviewMessage, ctx: MessageHandlerContext): void {
  const handler = messageHandlers[message.type] as MessageHandler<typeof message>;
  handler(message, ctx);
}
