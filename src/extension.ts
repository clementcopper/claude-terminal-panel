import * as vscode from 'vscode';
import { ClaudeTerminalViewProvider } from './ClaudeTerminalViewProvider';
import { initLog, log } from './log';

let terminalProvider: ClaudeTerminalViewProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
  // Before anything else: the provider's constructor already has something to say.
  const output = vscode.window.createOutputChannel('Claude Terminal');
  context.subscriptions.push(output);
  initLog(output);
  log('ext', 'activate');

  terminalProvider = new ClaudeTerminalViewProvider(context.extensionUri, context.workspaceState);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('claudeTerminal.terminalView', terminalProvider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeTerminal.restart', () => {
      terminalProvider?.restart();
    })
  );

  // Multi-tab commands
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeTerminal.newTab', () => {
      terminalProvider?.newTabInActiveGroup();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeTerminal.newTabContinue', () => {
      void terminalProvider?.createTerminalWithSessionFlag('--continue');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeTerminal.newTabResume', () => {
      void terminalProvider?.createTerminalWithSessionFlag('--resume');
    })
  );

  // Session commands that act on the current tab instead of opening a new one
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeTerminal.resumeSession', () => {
      terminalProvider?.resumeActiveTerminal();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeTerminal.continueSession', () => {
      terminalProvider?.continueActiveTerminal();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeTerminal.insertEditorReference', () => {
      terminalProvider?.insertEditorReference();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeTerminal.closeTab', () => {
      terminalProvider?.closeActiveTerminal();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeTerminal.nextTab', () => {
      terminalProvider?.switchToNextTerminal();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeTerminal.previousTab', () => {
      terminalProvider?.switchToPreviousTerminal();
    })
  );

  // Group commands — the outer tab level. A group owns a working directory; its terminals
  // inherit it.
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeTerminal.newGroup', () => {
      void terminalProvider?.promptAndCreateGroup();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeTerminal.closeGroup', () => {
      terminalProvider?.closeActiveGroup();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeTerminal.nextGroup', () => {
      terminalProvider?.switchToNextGroup();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeTerminal.previousGroup', () => {
      terminalProvider?.switchToPreviousGroup();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeTerminal')) {
        terminalProvider?.updateConfig();
      }
    })
  );
}

export function deactivate() {
  terminalProvider?.dispose();
}
