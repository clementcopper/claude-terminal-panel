import * as vscode from 'vscode';
import * as nodePath from 'path';
import type { EditorContext } from './types';

export type EditorContextCallback = (context: EditorContext | null) => void;

/**
 * Reports which file is open in the editor, and which lines are selected in it.
 *
 * The panel sits next to the editor but knows nothing about it: its PTY only carries bytes.
 * This is the other direction — what the window is looking at, so the status line can show it
 * and the reference command has something to insert.
 *
 * Selection changes fire per keystroke and per mouse move while dragging, and the status line
 * changes the terminal height, so every superfluous update costs a refit. Hence the debounce
 * plus a comparison against the last state that was actually reported.
 */
export class EditorContextTracker {
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;
  private last: EditorContext | null = null;
  private disposed = false;

  constructor(
    private readonly onChange: EditorContextCallback,
    private readonly debounceMs = 300
  ) {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        // Switching editors is a deliberate act, not a stream of events: report it at once,
        // or the row lags behind the tab the user just clicked.
        this.publish(true);
      }),
      vscode.window.onDidChangeTextEditorSelection(() => {
        this.publish(false);
      })
    );

    this.publish(true);
  }

  /** The current context, for a command that runs without waiting for an event. */
  get current(): EditorContext | null {
    return this.read();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }

  private publish(immediate: boolean): void {
    if (this.disposed) return;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    if (immediate) {
      this.emit();
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.emit();
    }, this.debounceMs);
  }

  private emit(): void {
    if (this.disposed) return;

    const context = this.read();
    if (sameContext(this.last, context)) {
      return;
    }
    this.last = context;
    this.onChange(context);
  }

  /**
   * Only real files on disk. The output panel, the SCM diff views and the comment editor are
   * text editors too, and a path from one of them is either meaningless as a reference or not
   * openable at all.
   */
  private read(): EditorContext | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      return null;
    }

    const fsPath = editor.document.uri.fsPath;
    const context: EditorContext = {
      fileName: nodePath.basename(fsPath),
      relativePath: vscode.workspace.asRelativePath(editor.document.uri, false)
    };

    // A cursor is not a selection. Line numbers without a marked range say nothing worth the
    // width they take up in a sidebar.
    const selection = editor.selection;
    if (!selection.isEmpty) {
      context.startLine = selection.start.line + 1;
      // A selection that ends in column 0 stops at the line break above: VS Code's own line
      // numbers do not count that line either.
      const endLine =
        selection.end.character === 0 && selection.end.line > selection.start.line
          ? selection.end.line
          : selection.end.line + 1;
      context.endLine = endLine;
    }

    return context;
  }
}

function sameContext(a: EditorContext | null, b: EditorContext | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    a.relativePath === b.relativePath &&
    a.startLine === b.startLine &&
    a.endLine === b.endLine &&
    a.fileName === b.fileName
  );
}

/**
 * How a reference reads in the prompt. The at-mention is what makes Claude Code resolve the
 * file; the range is plain prose after it, because the mention parser is not documented to
 * accept a suffix and a mention that fails to resolve is worse than a wordier one.
 *
 * No trailing newline anywhere: this lands in Claude's input, and sending it is the user's call.
 */
export function formatReference(context: EditorContext): string {
  const mention = `@${context.relativePath}`;
  if (context.startLine === undefined || context.endLine === undefined) {
    return `${mention} `;
  }
  if (context.startLine === context.endLine) {
    return `${mention} (line ${String(context.startLine)}) `;
  }
  return `${mention} (lines ${String(context.startLine)}-${String(context.endLine)}) `;
}
