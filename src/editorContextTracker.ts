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
  /** Beyond this the at-mention is both smaller and easier to read than the quoted code. */
  private static readonly MAX_SNIPPET_CHARS = 8000;

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
      }),
      // An image, a PDF or any other custom editor never fires the two events above — it is not
      // a TextEditor at all. The tab API is the only thing that sees those.
      vscode.window.tabGroups.onDidChangeTabs(() => {
        this.publish(true);
      }),
      vscode.window.tabGroups.onDidChangeTabGroups(() => {
        this.publish(true);
      })
    );

    this.publish(true);
  }

  /** The current context, for a command that runs without waiting for an event. */
  get current(): EditorContext | null {
    return this.read();
  }

  /**
   * What the reference command puts into the prompt.
   *
   * A selection becomes the selected code itself. The at-mention would pull the whole file
   * instead — measured on a 270-line file: 7422 bytes arrive for 120 bytes of selection — and
   * the lines someone highlighted are the ones they mean. If more is needed, reading the file
   * is one tool call away.
   *
   * Without a selection there is nothing to quote, so the mention stands.
   */
  currentPromptText(): string | null {
    const context = this.read();
    if (!context) {
      return null;
    }

    const editor = vscode.window.activeTextEditor;
    const selectedText =
      editor && context.startLine !== undefined && !editor.selection.isEmpty
        ? editor.document.getText(editor.selection)
        : '';

    // Past a certain size the snippet stops being cheaper than the file it came from, and a
    // paste that long is unwieldy in the prompt either way.
    if (selectedText.length === 0 || selectedText.length > EditorContextTracker.MAX_SNIPPET_CHARS) {
      return formatReference(context);
    }

    return formatSnippet(context, selectedText, editor?.document.languageId ?? '');
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
   * What the window is showing, from two sources that answer different halves of the question.
   *
   * `activeTextEditor` is the only one that knows about a selection, but it covers text editors
   * alone — open an image, a PDF or any other custom editor and it is simply `undefined`. The tab
   * API sees every kind of editor but has no notion of a cursor. So: the active tab decides
   * *which* file, the text editor contributes the lines when it happens to be showing that same
   * file.
   */
  private read(): EditorContext | null {
    const active = vscode.window.activeTextEditor;
    const editor = active?.document.uri.scheme === 'file' ? active : undefined;
    const tabUri = activeTabUri();

    // Focus in the sidebar or the panel leaves `activeTextEditor` pointing at the last text
    // editor, which is what should still be shown — so it wins whenever the tab API has nothing
    // usable to say.
    if (editor && (!tabUri || tabUri.toString() === editor.document.uri.toString())) {
      return withSelection(buildContext(editor.document.uri), editor.selection);
    }

    if (tabUri) {
      // A different kind of editor is in front: name it, but there are no lines to report.
      return buildContext(tabUri);
    }

    return editor ? withSelection(buildContext(editor.document.uri), editor.selection) : null;
  }
}

function buildContext(uri: vscode.Uri): EditorContext {
  return {
    fileName: nodePath.basename(uri.fsPath),
    relativePath: vscode.workspace.asRelativePath(uri, false)
  };
}

/**
 * A cursor is not a selection: line numbers without a marked range say nothing worth the width
 * they take up in a sidebar.
 */
function withSelection(context: EditorContext, selection: vscode.Selection): EditorContext {
  if (selection.isEmpty) {
    return context;
  }

  return {
    ...context,
    startLine: selection.start.line + 1,
    // A selection ending in column 0 stops at the line break above; VS Code's own line numbers
    // do not count that line either.
    endLine:
      selection.end.character === 0 && selection.end.line > selection.start.line
        ? selection.end.line
        : selection.end.line + 1
  };
}

/**
 * The file behind the active tab, whatever kind of editor renders it — text, image, notebook,
 * diff. Only `file:` URIs: the output panel and the SCM views are tabs too, and a path from one
 * of them is not something anyone can open.
 */
function activeTabUri(): vscode.Uri | undefined {
  const input: unknown = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input === null || typeof input !== 'object') {
    return undefined;
  }

  // Structural rather than `instanceof`: TabInputText, TabInputCustom and TabInputNotebook each
  // carry `uri`, and a diff carries the modified side as `modified`.
  const candidate = input as { uri?: unknown; modified?: unknown };
  const uri = candidate.uri ?? candidate.modified;

  return uri instanceof vscode.Uri && uri.scheme === 'file' ? uri : undefined;
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

/**
 * The selected code itself, headed by where it came from.
 *
 * The location is written as `path:line` rather than as an at-mention: a mention would make
 * Claude Code pull the whole file, which is exactly what quoting the selection avoids. Plain
 * text keeps it a label — still clickable in most terminals, and unambiguous to read.
 *
 * Fenced, because the block would otherwise run into the surrounding prompt, and a fence is
 * what a model reads as "this is quoted code, not an instruction".
 */
export function formatSnippet(
  context: EditorContext,
  selectedText: string,
  languageId: string
): string {
  const range =
    context.startLine !== undefined && context.endLine !== undefined
      ? context.startLine === context.endLine
        ? `:${String(context.startLine)}`
        : `:${String(context.startLine)}-${String(context.endLine)}`
      : '';

  // A fence inside the selection would end the block early — make ours longer than any run of
  // backticks it contains.
  const longestRun = /`+/g.exec(selectedText) ? longestBacktickRun(selectedText) : 0;
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  const language = /^[a-z0-9+#-]+$/i.test(languageId) ? languageId : '';

  return `${context.relativePath}${range}\n${fence}${language}\n${selectedText}\n${fence}\n`;
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length);
  }
  return longest;
}
