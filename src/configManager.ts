import * as vscode from 'vscode';
import type { TerminalConfig } from './types';

/**
 * Manages terminal configuration with caching.
 * Configuration is cached and invalidated when VS Code settings change.
 */
export class ConfigManager {
  private cachedConfig: TerminalConfig | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    // Listen for configuration changes and invalidate cache
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('claudeTerminal')) {
          this.invalidateCache();
        }
      })
    );
  }

  /**
   * Gets the current terminal configuration (cached).
   */
  getConfig(): TerminalConfig {
    if (this.cachedConfig) {
      return this.cachedConfig;
    }

    const config = vscode.workspace.getConfiguration('claudeTerminal');
    this.cachedConfig = {
      command: config.get<string>('command', 'claude'),
      opencodeCommand: config.get<string>('opencodeCommand', 'opencode'),
      args: config.get<string[]>('args', []),
      autoRun: config.get<boolean>('autoRun', true),
      shell: config.get<string>('shell', ''),
      env: config.get<Record<string, string>>('env', {}),
      directMode: config.get<boolean>('directMode', true),
      cwd: config.get<string>('cwd', ''),
      statusLine: config.get<boolean>('statusLine', true),
      statusLineProvider: config.get<'bundled' | 'own'>('statusLineProvider', 'bundled'),
      statusLineCompactBudget: config.get<number>('statusLineCompactBudget', 0),
      editorContext: config.get<boolean>('editorContext', true),
      contextThreshold: config.get<number>('contextThreshold', 60)
    };

    return this.cachedConfig;
  }

  /**
   * Invalidates the cached configuration.
   */
  invalidateCache(): void {
    this.cachedConfig = undefined;
  }

  /**
   * Disposes of resources.
   */
  dispose(): void {
    this.disposables.forEach((d) => {
      d.dispose();
    });
    this.disposables.length = 0;
  }
}
