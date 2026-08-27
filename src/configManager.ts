import * as vscode from 'vscode';
import type { TerminalConfig } from './types';

/**
 * Reads the `claudeTerminal.*` settings.
 *
 * Deliberately uncached: `vscode.workspace.getConfiguration` already resolves from memory, so a
 * cache in front of it bought nothing and cost an invalidation path plus a second
 * `onDidChangeConfiguration` listener — extension.ts already has one for the same event.
 */
export function getConfig(): TerminalConfig {
  const config = vscode.workspace.getConfiguration('claudeTerminal');
  return {
    command: config.get<string>('command', 'claude'),
    args: config.get<string[]>('args', []),
    autoRun: config.get<boolean>('autoRun', true),
    shell: config.get<string>('shell', ''),
    env: config.get<Record<string, string>>('env', {}),
    directMode: config.get<boolean>('directMode', true),
    cwd: config.get<string>('cwd', ''),
    preloadHelp: config.get<boolean>('preloadHelp', false),
    statusLine: config.get<boolean>('statusLine', true),
    statusLineProvider: config.get<'bundled' | 'own'>('statusLineProvider', 'bundled'),
    statusLineCompactBudget: config.get<number>('statusLineCompactBudget', 0),
    editorContext: config.get<boolean>('editorContext', true)
  };
}
