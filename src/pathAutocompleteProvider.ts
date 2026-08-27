import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PathSuggestion, PathFilterMode } from './types';

export interface PathAutocompleteOptions {
  debounceMs?: number;
  maxResults?: number;
  cacheMaxAge?: number;
}

interface CacheEntry {
  suggestions: PathSuggestion[];
  timestamp: number;
}

export class PathAutocompleteProvider {
  private cache = new Map<string, CacheEntry>();
  private debounceTimer: NodeJS.Timeout | undefined;
  private options: Required<PathAutocompleteOptions>;

  constructor(options: PathAutocompleteOptions = {}) {
    this.options = {
      debounceMs: options.debounceMs ?? 100,
      maxResults: options.maxResults ?? 20,
      cacheMaxAge: options.cacheMaxAge ?? 30000
    };
  }

  /**
   * Get path suggestions with debouncing.
   */
  getDebouncedSuggestions(
    partialPath: string,
    filterMode: PathFilterMode,
    isAbsolute: boolean,
    callback: (suggestions: PathSuggestion[]) => void
  ): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.getSuggestions(partialPath, filterMode, isAbsolute)
        .then(callback)
        .catch(() => {
          callback([]);
        });
    }, this.options.debounceMs);
  }

  /**
   * Get path suggestions immediately.
   */
  async getSuggestions(
    partialPath: string,
    filterMode: PathFilterMode,
    isAbsolute: boolean
  ): Promise<PathSuggestion[]> {
    // Show workspace folders as defaults when multiple folders exist and input is empty
    const workspaceFolders = this.getWorkspaceFolders();
    if (!partialPath && !isAbsolute && workspaceFolders.length > 1) {
      return workspaceFolders.map((folder) => ({
        name: folder.name,
        path: folder.path + '/',
        isDirectory: true
      }));
    }

    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot && !isAbsolute) {
      return [];
    }

    // Check if path uses tilde notation
    const useTilde = partialPath.startsWith('~');

    const { dirPath, prefix } = this.parsePartialPath(partialPath, isAbsolute, workspaceRoot);

    // Show hidden files if user explicitly types a dot prefix
    const showHidden = prefix.startsWith('.');

    // Check cache
    const cacheKey = JSON.stringify([dirPath, filterMode, showHidden, useTilde]);
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.options.cacheMaxAge) {
      return this.filterByPrefix(cached.suggestions, prefix);
    }

    // List directory contents
    const suggestions = await this.listDirectory(
      dirPath,
      filterMode,
      isAbsolute,
      workspaceRoot,
      showHidden,
      useTilde
    );

    // Update cache
    this.cache.set(cacheKey, { suggestions, timestamp: Date.now() });

    return this.filterByPrefix(suggestions, prefix);
  }

  private expandTilde(p: string): string {
    if (p.startsWith('~/')) {
      return path.join(os.homedir(), p.slice(2));
    }
    if (p === '~') {
      return os.homedir();
    }
    return p;
  }

  private parsePartialPath(
    partialPath: string,
    isAbsolute: boolean,
    workspaceRoot: string | null
  ): { dirPath: string; prefix: string } {
    // Normalize path separators
    let normalized = partialPath.replace(/\\/g, '/');

    // Expand tilde to home directory
    const hasTilde = normalized.startsWith('~');
    if (hasTilde) {
      normalized = this.expandTilde(normalized);
    }

    // Split into directory and prefix
    const lastSlash = normalized.lastIndexOf('/');
    let dirPath: string;
    let prefix: string;

    if (lastSlash === -1) {
      // No slash - listing root
      if (hasTilde) {
        // Just "~" typed - list home directory
        dirPath = os.homedir();
        prefix = '';
      } else {
        dirPath = isAbsolute ? '/' : (workspaceRoot ?? '');
        prefix = normalized;
      }
    } else {
      // Has slash - listing a subdirectory
      const subDir = normalized.substring(0, lastSlash) || '/';
      prefix = normalized.substring(lastSlash + 1);

      if (isAbsolute || hasTilde) {
        dirPath = subDir;
      } else {
        dirPath = path.join(workspaceRoot ?? '', subDir);
      }
    }

    return { dirPath, prefix };
  }

  private collapseTilde(p: string): string {
    const home = os.homedir();
    if (p === home) {
      return '~';
    }
    if (p.startsWith(home + path.sep)) {
      return '~/' + p.slice(home.length + 1);
    }
    return p;
  }

  private async listDirectory(
    dirPath: string,
    filterMode: PathFilterMode,
    isAbsolute: boolean,
    workspaceRoot: string | null,
    showHidden: boolean = false,
    useTilde: boolean = false
  ): Promise<PathSuggestion[]> {
    try {
      // Check if directory exists using async access
      try {
        await fs.promises.access(dirPath);
      } catch {
        return [];
      }

      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      const suggestions: PathSuggestion[] = [];

      for (const entry of entries) {
        // Skip hidden files unless explicitly requested (user typed '.')
        if (entry.name.startsWith('.') && !showHidden) {
          continue;
        }

        const isDirectory = entry.isDirectory();

        // Apply filter
        if (filterMode === 'files' && isDirectory) continue;
        if (filterMode === 'directories' && !isDirectory) continue;

        // Compute the path to display
        let displayPath: string;
        if (isAbsolute || useTilde) {
          const fullPath = path.join(dirPath, entry.name);
          displayPath = useTilde ? this.collapseTilde(fullPath) : fullPath;
        } else {
          const fullPath = path.join(dirPath, entry.name);
          displayPath = path.relative(workspaceRoot ?? '', fullPath);
        }

        suggestions.push({
          name: entry.name,
          path: displayPath + (isDirectory ? '/' : ''),
          isDirectory
        });
      }

      // Sort: directories first, then alphabetically
      suggestions.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      // Don't slice here - cache all items so filtering works correctly
      return suggestions;
    } catch {
      return [];
    }
  }

  private filterByPrefix(suggestions: PathSuggestion[], prefix: string): PathSuggestion[] {
    let filtered = suggestions;
    if (prefix) {
      const lowerPrefix = prefix.toLowerCase();
      filtered = suggestions.filter((s) => s.name.toLowerCase().startsWith(lowerPrefix));
    }
    // Apply maxResults limit after filtering
    return filtered.slice(0, this.options.maxResults);
  }

  private getWorkspaceRoot(): string | null {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  }

  private getWorkspaceFolders(): Array<{ name: string; path: string }> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) {
      return [];
    }
    return folders.map((folder) => ({
      name: folder.name,
      path: folder.uri.fsPath
    }));
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.cache.clear();
  }
}
