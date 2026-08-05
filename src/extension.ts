import * as vscode from 'vscode';
import { ClaudeTerminalViewProvider } from './ClaudeTerminalViewProvider';

let terminalProvider: ClaudeTerminalViewProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
  terminalProvider = new ClaudeTerminalViewProvider(context.extensionUri);

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
      void terminalProvider?.createTerminal();
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
