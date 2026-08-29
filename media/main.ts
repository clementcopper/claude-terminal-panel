import { Terminal, type ILinkProvider, type ILink } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type {
  VSCodeAPI,
  WebviewIncomingMessage,
  WebviewOutgoingMessage,
  TabInfo,
  TerminalEntry,
  XTermTheme,
  StatusLineSnapshot,
  EditorContext
} from './types';

// File path link provider for terminal
class FileLinkProvider implements ILinkProvider {
  // Regex to match file paths with optional :line:column
  // Matches: /path/file.ts, ./file.ts, src/file.ts:10:5, ~/file.ts
  // Also matches extensionless files: Makefile, Dockerfile, src/Makefile
  private static readonly FILE_PATH_REGEX =
    /(?:^|[\s"'`([{])([.~]?\/[\w./-]+(?:\.[a-zA-Z0-9]+)?|[\w.-]+\/[\w./-]+(?:\.[a-zA-Z0-9]+)?)(?::(\d+))?(?::(\d+))?/g;

  // Common extensionless files that should be recognized
  private static readonly EXTENSIONLESS_FILES = new Set([
    'Makefile',
    'Dockerfile',
    'Containerfile',
    'Vagrantfile',
    'Procfile',
    'Gemfile',
    'Rakefile',
    'Brewfile',
    'Justfile',
    'Taskfile',
    'Earthfile',
    'CMakeLists',
    'GNUmakefile',
    'BSDmakefile'
  ]);

  constructor(
    private readonly terminal: Terminal,
    private readonly terminalId: string,
    private readonly postMessage: (msg: WebviewOutgoingMessage) => void
  ) {}

  provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
    const line = this.terminal.buffer.active.getLine(bufferLineNumber - 1);
    if (!line) {
      callback(undefined);
      return;
    }

    const lineText = line.translateToString();
    const links: ILink[] = [];

    // Reset regex state
    FileLinkProvider.FILE_PATH_REGEX.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = FileLinkProvider.FILE_PATH_REGEX.exec(lineText)) !== null) {
      const fullMatch = match[0];
      const path = match[1];
      const lineNum = match[2] ? parseInt(match[2], 10) : undefined;
      const column = match[3] ? parseInt(match[3], 10) : undefined;

      // Skip paths without extensions unless they're known extensionless files
      const hasExtension = /\.[a-zA-Z0-9]+$/.test(path);
      if (!hasExtension) {
        const filename = path.split('/').pop() ?? '';
        if (!FileLinkProvider.EXTENSIONLESS_FILES.has(filename)) {
          continue;
        }
      }

      // Calculate the start position (skip leading whitespace/quotes captured)
      const pathStart = match.index + fullMatch.indexOf(path);
      const pathEnd =
        pathStart +
        path.length +
        (match[2] ? `:${match[2]}`.length : 0) +
        (match[3] ? `:${match[3]}`.length : 0);

      links.push({
        range: {
          start: { x: pathStart + 1, y: bufferLineNumber },
          end: { x: pathEnd + 1, y: bufferLineNumber }
        },
        text: path,
        activate: () => {
          this.postMessage({
            type: 'openFile',
            id: this.terminalId,
            path,
            line: lineNum,
            column
          });
        }
      });
    }

    callback(links.length > 0 ? links : undefined);
  }
}

// State management class replacing closure variables
class TerminalState {
  private readonly terminals = new Map<string, TerminalEntry>();
  private activeTerminalId: string | null = null;

  get(id: string): TerminalEntry | undefined {
    return this.terminals.get(id);
  }

  set(id: string, entry: TerminalEntry): void {
    this.terminals.set(id, entry);
  }

  delete(id: string): boolean {
    return this.terminals.delete(id);
  }

  forEach(callback: (entry: TerminalEntry, id: string) => void): void {
    this.terminals.forEach(callback);
  }

  getActiveId(): string | null {
    return this.activeTerminalId;
  }

  setActiveId(id: string | null): void {
    this.activeTerminalId = id;
  }
}

// Theme and font builder with caching
class ThemeBuilder {
  private cachedTheme: XTermTheme | null = null;
  private cachedFontFamily: string | null = null;

  private static readonly DEFAULT_FONT_FAMILY = 'Menlo, Monaco, "Courier New", monospace';

  private getCssVar(name: string, fallback: string): string {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  getFontFamily(): string {
    if (this.cachedFontFamily) {
      return this.cachedFontFamily;
    }

    // Read VSCode's editor font family from CSS variable
    const editorFont = this.getCssVar('--vscode-editor-font-family', '');
    this.cachedFontFamily = editorFont || ThemeBuilder.DEFAULT_FONT_FAMILY;

    return this.cachedFontFamily;
  }

  getTheme(): XTermTheme {
    if (this.cachedTheme) {
      return this.cachedTheme;
    }

    this.cachedTheme = {
      background: this.getCssVar(
        '--vscode-terminal-background',
        this.getCssVar('--vscode-editor-background', '#1e1e1e')
      ),
      foreground: this.getCssVar(
        '--vscode-terminal-foreground',
        this.getCssVar('--vscode-editor-foreground', '#d4d4d4')
      ),
      cursor: this.getCssVar('--vscode-terminalCursor-foreground', '#d4d4d4'),
      cursorAccent: this.getCssVar('--vscode-terminalCursor-background', '#1e1e1e'),
      selectionBackground: this.getCssVar('--vscode-terminal-selectionBackground', '#264f78'),
      black: this.getCssVar('--vscode-terminal-ansiBlack', '#000000'),
      red: this.getCssVar('--vscode-terminal-ansiRed', '#cd3131'),
      green: this.getCssVar('--vscode-terminal-ansiGreen', '#0dbc79'),
      yellow: this.getCssVar('--vscode-terminal-ansiYellow', '#e5e510'),
      blue: this.getCssVar('--vscode-terminal-ansiBlue', '#2472c8'),
      magenta: this.getCssVar('--vscode-terminal-ansiMagenta', '#bc3fbc'),
      cyan: this.getCssVar('--vscode-terminal-ansiCyan', '#11a8cd'),
      white: this.getCssVar('--vscode-terminal-ansiWhite', '#e5e5e5'),
      brightBlack: this.getCssVar('--vscode-terminal-ansiBrightBlack', '#666666'),
      brightRed: this.getCssVar('--vscode-terminal-ansiBrightRed', '#f14c4c'),
      brightGreen: this.getCssVar('--vscode-terminal-ansiBrightGreen', '#23d18b'),
      brightYellow: this.getCssVar('--vscode-terminal-ansiBrightYellow', '#f5f543'),
      brightBlue: this.getCssVar('--vscode-terminal-ansiBrightBlue', '#3b8eea'),
      brightMagenta: this.getCssVar('--vscode-terminal-ansiBrightMagenta', '#d670d6'),
      brightCyan: this.getCssVar('--vscode-terminal-ansiBrightCyan', '#29b8db'),
      brightWhite: this.getCssVar('--vscode-terminal-ansiBrightWhite', '#ffffff')
    };

    return this.cachedTheme;
  }

  invalidateCache(): void {
    this.cachedTheme = null;
    this.cachedFontFamily = null;
  }
}

// Scroll management for terminal viewport
class ScrollManager {
  static isAtBottom(terminal: InstanceType<typeof Terminal>): boolean {
    const buffer = terminal.buffer.active;
    return buffer.viewportY >= buffer.baseY - 1;
  }

  static setupScrollTracking(entry: TerminalEntry): void {
    entry.terminal.onScroll(() => {
      entry.isAtBottom = this.isAtBottom(entry.terminal);
    });

    const viewport = entry.element.querySelector('.xterm-viewport') as HTMLElement;
    if (viewport) {
      viewport.addEventListener(
        'scroll',
        () => {
          entry.lastScrollTop = viewport.scrollTop;
          entry.isAtBottom = this.isAtBottom(entry.terminal);
        },
        { passive: true }
      );
    }
  }
}

// Handler registry pattern for message handling
type MessageHandler<T extends WebviewIncomingMessage> = (message: T, ctx: WebviewContext) => void;

/**
 * Keyed off the message union rather than listed by hand, so a new incoming message that has no
 * handler here fails the build instead of being dropped in silence — the same guarantee the
 * extension side gets from `src/messageHandlers.ts`.
 */
type MessageHandlers = {
  [K in WebviewIncomingMessage['type']]: MessageHandler<
    Extract<WebviewIncomingMessage, { type: K }>
  >;
};

const messageHandlers: MessageHandlers = {
  output: (message, ctx) => {
    const t = ctx.state.get(message.id);
    if (t) {
      const wasAtBottom = ScrollManager.isAtBottom(t.terminal);
      t.terminal.write(message.data);
      if (wasAtBottom) {
        requestAnimationFrame(() => t.terminal.scrollToBottom());
      }
    }
  },
  clear: (message, ctx) => {
    const t = ctx.state.get(message.id);
    if (t) {
      t.terminal.clear();
      t.isAtBottom = true;
      t.lastScrollTop = 0;
    }
  },
  tabsUpdate: (message, ctx) => {
    ctx.renderTabBar(message.tabs);
  },
  createTab: (message, ctx) => {
    ctx.createTerminalElement(message.id);
  },
  switchTab: (message, ctx) => {
    ctx.switchToTerminal(message.id);
  },
  removeTab: (message, ctx) => {
    ctx.removeTerminal(message.id);
  },
  setNotification: (message, ctx) => {
    ctx.setTabNotification(message.id, message.show);
  },
  statusLine: (message, ctx) => {
    ctx.setStatusLine(message.id, message.data);
  },
  editorContext: (message, ctx) => {
    ctx.setEditorContext(message.data);
  },
  focusTerminal: (_message, ctx) => {
    ctx.focusActiveTerminal();
  },
  contextThreshold: (message, ctx) => {
    ctx.setContextThreshold(message.value);
  }
};

/**
 * Tooltips in the shape VS Code uses for its own toolbars.
 *
 * The `title` attribute would be simpler, but it is the browser's tooltip: about a second of
 * delay and the operating system's styling, next to the view title bar's themed hover that
 * appears right away. Anything carrying `data-tooltip` gets this one instead.
 */
class TooltipManager {
  /** Matches the feel of the title bar hover rather than the browser's own delay. */
  private static readonly SHOW_DELAY_MS = 300;
  private static readonly GAP_PX = 6;

  private readonly element: HTMLDivElement;
  private timer: number | null = null;
  private target: HTMLElement | null = null;
  /**
   * While something is pinned the tooltip belongs to it and to nothing else: hover, mousedown and
   * scroll stop dismissing it. Dragging the threshold handle is the case — the pointer is
   * captured, the value changes under it, and the number is the whole point of the gesture.
   */
  private pinned: HTMLElement | null = null;

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'panel-tooltip';
    this.element.hidden = true;
    document.body.appendChild(this.element);

    // Delegated, because tabs are rebuilt on every update — per-element listeners would have to
    // be reattached each time.
    document.addEventListener('mouseover', (event) => {
      if (this.pinned) return;
      const found = this.findTarget(event.target);
      if (found !== this.target) {
        this.schedule(found);
      }
    });
    document.addEventListener('mouseleave', () => {
      this.hide();
    });
    document.addEventListener('mousedown', () => {
      this.hide();
    });
    window.addEventListener('blur', () => {
      this.hide();
    });
    window.addEventListener('scroll', () => {
      this.hide();
    });
  }

  private findTarget(node: EventTarget | null): HTMLElement | null {
    if (!(node instanceof Element)) return null;
    const match = node.closest('[data-tooltip]');
    return match instanceof HTMLElement && match.dataset.tooltip ? match : null;
  }

  private schedule(target: HTMLElement | null): void {
    this.clearTimer();
    this.target = target;

    if (!target) {
      this.element.hidden = true;
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      this.show(target);
    }, TooltipManager.SHOW_DELAY_MS) as unknown as number;
  }

  private show(target: HTMLElement): void {
    const text = target.dataset.tooltip;
    if (!text || !target.isConnected) return;

    this.element.textContent = text;
    this.element.hidden = false;

    // Measure after the text is in, then place it. The tab bar sits on the right edge, so the
    // default side is to the left of the element; above is the fallback for wide targets.
    const targetRect = target.getBoundingClientRect();
    const tip = this.element.getBoundingClientRect();
    const gap = TooltipManager.GAP_PX;

    let left: number;
    let top: number;

    if (target.dataset.tooltipPlacement === 'above') {
      // Centred over the target. The threshold handle asks for this: it travels the width of the
      // bar, and a tooltip beside it would read as belonging to whatever it happens to sit next
      // to. Below is the fallback when the target is close to the top edge.
      left = targetRect.left + targetRect.width / 2 - tip.width / 2;
      top = targetRect.top - tip.height - gap;
      if (top < gap) {
        top = targetRect.bottom + gap;
      }
    } else {
      left = targetRect.left - tip.width - gap;
      top = targetRect.top + targetRect.height / 2 - tip.height / 2;

      if (left < gap) {
        left = Math.min(targetRect.left, window.innerWidth - tip.width - gap);
        top = targetRect.top - tip.height - gap;
        if (top < gap) {
          top = targetRect.bottom + gap;
        }
      }
    }

    left = Math.min(left, window.innerWidth - tip.width - gap);

    this.element.style.left = `${String(Math.max(gap, left))}px`;
    this.element.style.top = `${String(Math.max(gap, Math.min(top, window.innerHeight - tip.height - gap)))}px`;
  }

  /** Shows the element's tooltip at once — no delay — and holds it until `unpin`. */
  pin(target: HTMLElement): void {
    this.clearTimer();
    this.pinned = target;
    this.target = target;
    this.show(target);
  }

  /** Re-reads `data-tooltip` and places it again; the pinned value changes while it is shown. */
  refresh(): void {
    if (this.pinned) {
      this.show(this.pinned);
    }
  }

  unpin(): void {
    this.pinned = null;
    this.hide();
  }

  private hide(): void {
    if (this.pinned) return;
    this.clearTimer();
    this.target = null;
    this.element.hidden = true;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/**
 * The status line at the bottom edge. Data comes from the statusLine script through the
 * extension host — the terminal stream itself carries no session state.
 */
class StatusLineView {
  /** How far below the threshold the bar already turns orange, in points of the window. */
  private static readonly WARN_LEAD_PCT = 10;
  /** The slider cannot be dragged to the very ends — a threshold of 0 or 100 says nothing. */
  private static readonly MIN_THRESHOLD_PCT = 5;
  private static readonly MAX_THRESHOLD_PCT = 95;
  /** Nothing written for this long means Claude has not re-rendered since. */
  private static readonly STALE_AFTER_MS = 60_000;
  /** Redraw cadence for the reset countdown while no snapshot arrives. */
  private static readonly TICK_MS = 30_000;
  /** From here on the session limit is close enough to matter as much as a full context window. */
  private static readonly LIMIT_DANGER_PCT = 90;

  /** At this point the bucket is gone, not merely close — see `onCredits`. */
  private static readonly LIMIT_SPENT_PCT = 100;

  private readonly snapshots = new Map<string, StatusLineSnapshot>();
  private activeId: string | null = null;
  /** Belongs to the window, not to a tab: one editor, however many terminals. */
  private editorContext: EditorContext | null = null;
  /**
   * Keeps the countdown honest while nothing else happens. `sessionResetsAt` is an absolute point,
   * so the remaining time can be recomputed without Claude — which matters most exactly when the
   * limit is spent: no prompt goes through, Claude never renders, and a frozen "84 min" would be
   * the one number the row exists for.
   */
  private tickTimer: number | undefined;

  /** Mirrors the setting; the extension host owns the value, this is the drawn copy. */
  private threshold = 60;
  /**
   * A snapshot arriving mid-drag would empty the element and take the handle out from under the
   * pointer. Redraws are held back until the pointer is released, then run once.
   */
  private dragging = false;
  private redrawPending = false;

  constructor(
    private readonly element: HTMLElement,
    private readonly onHeightChange: () => void,
    private readonly onEditorReferenceClick: () => void,
    private readonly onStopTurn: () => void,
    private readonly onThresholdChange: (value: number) => void,
    private readonly tooltips: TooltipManager
  ) {}

  setThreshold(value: number): void {
    const clamped = StatusLineView.clampThreshold(value);
    if (clamped === this.threshold) return;
    this.threshold = clamped;
    this.render();
  }

  set(id: string, snapshot: StatusLineSnapshot | null): void {
    if (snapshot) {
      this.snapshots.set(id, snapshot);
    } else {
      this.snapshots.delete(id);
    }
    if (id === this.activeId) {
      this.render();
    }
  }

  setActive(id: string | null): void {
    this.activeId = id;
    this.render();
  }

  setEditorContext(context: EditorContext | null): void {
    this.editorContext = context;
    this.render();
  }

  remove(id: string): void {
    this.snapshots.delete(id);
    if (id === this.activeId) {
      this.activeId = null;
      this.render();
    }
  }

  /**
   * Rebuilds the whole element, then refits xterm if that changed the height.
   *
   * Measured rather than inferred from `hidden`: a row can now come and go while the element
   * stays visible — the editor row appears the moment a file is opened — and that moves the
   * terminal's bottom edge just as much as showing the status line does. Without the refit xterm
   * keeps its old row count.
   */
  private render(): void {
    if (this.dragging) {
      this.redrawPending = true;
      return;
    }

    const previousHeight = this.element.hidden ? 0 : this.element.offsetHeight;
    this.draw();
    const currentHeight = this.element.hidden ? 0 : this.element.offsetHeight;

    if (currentHeight !== previousHeight) {
      this.onHeightChange();
    }
  }

  private draw(): void {
    const snapshot = this.activeId ? this.snapshots.get(this.activeId) : undefined;
    this.scheduleTick(snapshot);

    // The editor row stands on its own: a tab Claude has not rendered yet still has a file open
    // next to it.
    if (!snapshot && !this.editorContext) {
      this.element.hidden = true;
      this.element.textContent = '';
      return;
    }

    this.element.textContent = '';

    // First, so it sits at the top edge — closest to the editor it describes
    if (this.editorContext) {
      this.element.appendChild(this.buildEditorRow(this.editorContext));
    }

    this.element.hidden = false;

    if (!snapshot) {
      this.element.classList.remove('stale');
      return;
    }

    this.element.appendChild(this.buildContextRow(snapshot));

    const secondary = this.buildSecondaryRow(snapshot);
    if (secondary) {
      this.element.appendChild(secondary);
    }

    // Directory last: least urgent, and the only part that can get long
    if (snapshot.cwd) {
      const cwdRow = document.createElement('div');
      cwdRow.className = 'status-row cwd';
      const cwd = document.createElement('span');
      cwd.className = 'status-cwd';
      // Shortened in JS, not by CSS: a right-to-left trick for left-side ellipsis
      // reorders a plain path ("~/foo" came out as "foo/~").
      cwd.textContent = shortenPath(snapshot.cwd);
      cwd.dataset.tooltip = snapshot.cwd;
      cwdRow.appendChild(cwd);
      this.element.appendChild(cwdRow);
    }

    const ageMs = Date.now() - snapshot.updatedAt * 1000;
    this.element.classList.toggle('stale', ageMs > StatusLineView.STALE_AFTER_MS);
  }

  /**
   * The stop button, at the head of the context row.
   *
   * It sits in the flow rather than in a corner: it is the only control left, and the row it
   * leads is the one that says how the turn is going. Fixed 16px box so the row's height is a
   * constant — a control that grows with its content would move the terminal's bottom edge.
   */
  private buildStopButton(): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'status-stop';
    button.type = 'button';
    button.dataset.tooltip =
      'Stop the current turn (same as Escape). Claude keeps the work done so far.';
    // The tooltip is a div elsewhere on the page, so the button still needs its own name
    button.setAttribute('aria-label', 'Stop the current turn');

    // createElementNS rather than innerHTML: SVG in an HTML string needs the namespace anyway,
    // and this keeps the webview free of markup assignment.
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 10 10');
    svg.setAttribute('aria-hidden', 'true');
    const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    shape.setAttribute('d', 'M2 2h6v6H2z');
    shape.setAttribute('fill', 'currentColor');
    svg.appendChild(shape);
    button.appendChild(svg);

    button.addEventListener('click', () => {
      this.onStopTurn();
    });

    return button;
  }

  private static clampThreshold(value: number): number {
    if (!Number.isFinite(value)) return 60;
    return Math.min(
      StatusLineView.MAX_THRESHOLD_PCT,
      Math.max(StatusLineView.MIN_THRESHOLD_PCT, Math.round(value))
    );
  }

  /**
   * The context bar plus the threshold handle above it.
   *
   * Two layers on purpose: the track has to clip its fill (`overflow: hidden` for the rounded
   * ends), while the handle has to stand proud of a 4px bar. The wrapper carries the grab zone,
   * padded upwards and pulled back with a negative margin so the row's height does not change.
   */
  private buildBar(usedPercent: number, level: string): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.className = 'status-bar-wrap';

    const bar = document.createElement('div');
    bar.className = `status-bar${level}`;
    const fill = document.createElement('div');
    fill.className = 'status-bar-fill';
    fill.style.width = `${String(Math.min(100, Math.max(0, usedPercent)))}%`;
    bar.appendChild(fill);
    wrap.appendChild(bar);

    const handle = document.createElement('div');
    handle.className = 'status-threshold';
    handle.dataset.tooltipPlacement = 'above';
    handle.setAttribute('role', 'slider');
    handle.setAttribute('aria-label', 'Context threshold');
    this.positionHandle(handle, this.threshold);
    wrap.appendChild(handle);

    this.wireThresholdDrag(wrap, handle);
    return wrap;
  }

  private positionHandle(handle: HTMLElement, value: number): void {
    handle.style.left = `${String(value)}%`;
    handle.dataset.tooltip = `${String(value)}%`;
    handle.setAttribute('aria-valuenow', String(value));
  }

  /**
   * Dragging the handle, and clicking the track to jump to a point.
   *
   * The value is only reported once the pointer is released: the setting is written to disk, and
   * writing it on every pixel of a drag would be a file write per frame.
   */
  private wireThresholdDrag(wrap: HTMLElement, handle: HTMLElement): void {
    const valueAt = (clientX: number): number => {
      const box = wrap.getBoundingClientRect();
      if (box.width <= 0) return this.threshold;
      return StatusLineView.clampThreshold(((clientX - box.left) / box.width) * 100);
    };

    const commit = (): void => {
      this.dragging = false;
      this.tooltips.unpin();
      this.onThresholdChange(this.threshold);
      if (this.redrawPending) {
        this.redrawPending = false;
        this.render();
      }
    };

    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.dragging = true;
      handle.setPointerCapture(event.pointerId);
      // Straight away and held: the number is what the gesture is for, and the pointer capture
      // means the usual hover rules stop applying the moment the handle moves under it.
      this.tooltips.pin(handle);
    });

    handle.addEventListener('pointermove', (event) => {
      if (!this.dragging) return;
      this.threshold = valueAt(event.clientX);
      this.positionHandle(handle, this.threshold);
      this.tooltips.refresh();
    });

    handle.addEventListener('pointerup', (event) => {
      if (!this.dragging) return;
      handle.releasePointerCapture(event.pointerId);
      commit();
    });

    handle.addEventListener('pointercancel', () => {
      if (this.dragging) commit();
    });

    // A click anywhere on the track moves the threshold there — the handle is 8px wide and the
    // panel is narrow, so aiming for it is not always worth it.
    wrap.addEventListener('pointerdown', (event) => {
      if (event.target === handle) return;
      this.threshold = valueAt(event.clientX);
      this.positionHandle(handle, this.threshold);
      this.onThresholdChange(this.threshold);
      this.render();
    });
  }

  /**
   * Runs the redraw timer only while there is a countdown to move. Started for a reset point in
   * the future, stopped once it passes or the tab has no limits — an interval that redraws a row
   * whose numbers cannot change is pure churn, and every redraw measures the height.
   */
  private scheduleTick(snapshot: StatusLineSnapshot | undefined): void {
    const resetsAt = snapshot?.sessionResetsAt;
    const wanted = resetsAt !== undefined && resetsAt * 1000 > Date.now();

    if (wanted && this.tickTimer === undefined) {
      this.tickTimer = window.setInterval(() => {
        this.render();
      }, StatusLineView.TICK_MS);
    } else if (!wanted && this.tickTimer !== undefined) {
      window.clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
  }

  /**
   * The open file, and the selected range when there is one. Clicking it hands the reference to
   * Claude's input — the row is the affordance, so it has to look like one.
   */
  private buildEditorRow(context: EditorContext): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'status-row editor';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'status-editor';

    const lines =
      context.startLine !== undefined && context.endLine !== undefined
        ? context.startLine === context.endLine
          ? `:${String(context.startLine)}`
          : `:${String(context.startLine)}-${String(context.endLine)}`
        : '';
    button.textContent = `${context.fileName}${lines}`;
    button.dataset.tooltip = `${context.relativePath}${lines} — click to add to the prompt`;

    button.addEventListener('click', () => {
      this.onEditorReferenceClick();
    });

    row.appendChild(button);
    return row;
  }

  private buildContextRow(snapshot: StatusLineSnapshot): HTMLDivElement {
    // One name for the level so bar and number can never disagree: '' below the lead-in,
    // then warn, then danger at the threshold itself.
    const level =
      snapshot.usedPercent >= this.threshold
        ? ' danger'
        : snapshot.usedPercent >= this.threshold - StatusLineView.WARN_LEAD_PCT
          ? ' warn'
          : '';
    // A tab that has not been rendered by Claude yet carries no numbers — show nothing rather
    // than a full bar reading "0 / 0". The row itself still exists: it carries the stop button,
    // which is worth having before the first render just as much as after it.
    const hasContext = snapshot.totalTokens > 0;

    const row = document.createElement('div');
    row.className = 'status-row';
    row.appendChild(this.buildStopButton());

    if (snapshot.model) {
      const model = document.createElement('span');
      model.className = 'status-model';
      model.textContent = snapshot.model;
      row.appendChild(model);
    }

    if (snapshot.effort) {
      const effort = document.createElement('span');
      effort.className = 'status-effort';
      effort.textContent = snapshot.effort;
      row.appendChild(effort);
    }

    if (hasContext) {
      row.appendChild(this.buildBar(snapshot.usedPercent, level));

      const percent = document.createElement('span');
      percent.className = `status-value${level}`;
      percent.textContent = `${String(Math.round(snapshot.usedPercent))}%`;
      row.appendChild(percent);

      // Only what is spent. The window size stays in the tooltip: it is the same number all
      // session long, so it earns its space once, not on every row.
      const tokens = document.createElement('span');
      tokens.className = 'status-value';
      tokens.textContent = formatK(snapshot.usedTokens);
      row.appendChild(tokens);

      // Terse on purpose: the row it describes is already labelled, so the tooltip only fills in
      // the two numbers the row drops — the window size and the threshold.
      row.dataset.tooltip = `${String(Math.round(snapshot.usedPercent))}% ${formatK(snapshot.usedTokens)} / ${formatK(snapshot.totalTokens)} · thr ${String(this.threshold)}%`;
    }

    return row;
  }

  private buildSecondaryRow(snapshot: StatusLineSnapshot): HTMLDivElement | null {
    const parts: { text: string; danger?: boolean; trailing?: boolean }[] = [];
    let sessionExpired = false;

    // With the weekly limit spent, turns are billed to usage credits and the five-hour bucket
    // stops counting — Claude Code then reports it as 0. A bare "Session 0%" would read as
    // plenty of room left, which is the opposite of the situation.
    const onCredits =
      snapshot.weekPercent !== undefined && snapshot.weekPercent >= StatusLineView.LIMIT_SPENT_PCT;

    if (snapshot.sessionPercent !== undefined) {
      // Prefer the absolute point: a remembered "84 min" is wrong an hour later
      const resetsAt = snapshot.sessionResetsAt;
      const remainingMs = resetsAt !== undefined ? resetsAt * 1000 - Date.now() : undefined;
      const minutes =
        remainingMs !== undefined ? Math.round(remainingMs / 60000) : snapshot.sessionResetsInMin;

      // Past the reset point the percentage describes a window that no longer exists — the
      // watcher drops it for the same reason when it fills a fresh tab from memory. Measured
      // against the point itself, not against the rounded minutes: rounding calls anything under
      // 30 seconds zero, which would blank the row in its last half minute.
      const expired = remainingMs !== undefined && remainingMs <= 0;

      sessionExpired = expired;

      if (expired) {
        // Not dropped silently: the row would just lose its left half at the very moment the
        // waiting is over. Says so until Claude's next render brings a fresh percentage.
        parts.push({ text: 'Limit reset' });
      } else {
        // Both, and in that order: the remaining span is the answer to "can I prompt again yet",
        // the clock time is what you plan around once you know it is a while.
        const clock = resetsAt !== undefined ? formatClock(resetsAt) : '';
        const resets = [minutes !== undefined ? formatRemaining(minutes) : '', clock]
          .filter((piece) => piece.length > 0)
          .map((piece) => ` · ${piece}`)
          .join('');
        const percent = Math.round(snapshot.sessionPercent);
        parts.push({
          text: `Session ${String(percent)}%${onCredits ? ' (Credits)' : ''}${resets}`,
          danger: onCredits || percent >= StatusLineView.LIMIT_DANGER_PCT
        });
      }
    }

    if (snapshot.compacted !== undefined) {
      const budget =
        snapshot.compactBudget !== undefined ? `/${String(snapshot.compactBudget)}` : '';
      const auto =
        snapshot.compactAuto !== undefined && snapshot.compactAuto > 0
          ? ` (${String(snapshot.compactAuto)} auto)`
          : '';
      parts.push({
        text: `Compacted ${String(snapshot.compacted)}${budget}${auto}`,
        trailing: true
      });
    }

    if (snapshot.weekPercent !== undefined) {
      const resets = snapshot.weekResetsAt ? ` · ${snapshot.weekResetsAt}` : '';
      const percent = Math.round(snapshot.weekPercent);
      parts.push({
        text: `Week ${String(percent)}%${resets}`,
        danger: percent >= StatusLineView.LIMIT_DANGER_PCT,
        trailing: true
      });
    }

    if (parts.length === 0) {
      return null;
    }

    const row = document.createElement('div');
    row.className = 'status-row secondary';
    // Only the first of the trailing group carries the push: the ones after it follow at the
    // normal gap, or each would be shoved to the edge in turn and the group would fall apart.
    let pushed = false;
    parts.forEach((part) => {
      const span = document.createElement('span');
      const classes = ['status-value'];
      if (part.danger) {
        classes.push('danger');
      }
      if (part.trailing && !pushed) {
        classes.push('trailing');
        pushed = true;
      }
      span.className = classes.join(' ');
      span.textContent = part.text;
      row.appendChild(span);
    });

    // The tooltip explains the row, so it may only name a limit the row actually shows.
    // Claude Code sends the two buckets independently and a reset time can arrive without its
    // percentage — the segment is then dropped while the tooltip still promised a "weekly limit"
    // nothing on screen mentioned.
    const tooltip: string[] = [];
    // A reset time in the past is not worth naming — the row already says the limit is back.
    if (
      snapshot.sessionPercent !== undefined &&
      snapshot.sessionResetsAt !== undefined &&
      !sessionExpired
    ) {
      tooltip.push(`Session limit resets at ${formatClock(snapshot.sessionResetsAt)}`);
    }
    if (snapshot.weekPercent !== undefined && snapshot.weekResetsAt) {
      tooltip.push(`Weekly limit resets on ${snapshot.weekResetsAt}`);
    }
    if (onCredits) {
      tooltip.push('Weekly limit spent — turns run on usage credits');
    }
    if (tooltip.length > 0) {
      row.dataset.tooltip = tooltip.join('\n');
    }
    return row;
  }
}

/**
 * Compact token counts the way the statusLine script does: integers from 100k up, one
 * decimal below that, comma as the decimal separator.
 */
/**
 * Keeps the tail of a path, which is the part that identifies the project.
 * `~/work/clients/acme/api` becomes `…/acme/api`; short paths stay whole.
 */
function shortenPath(path: string, maxSegments = 2): string {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  if (segments.length <= maxSegments || path.length <= 28) {
    return path;
  }
  return `…/${segments.slice(-maxSegments).join('/')}`;
}

/**
 * `42 min` below the hour, `3 h 12` above. A raw minute count stops being readable past 60, and
 * the whole point of this row is that it can be read at a glance.
 */
function formatRemaining(minutes: number): string {
  // Rounding to zero is not the same as being over: the last half minute still counts.
  if (minutes < 1) {
    return '< 1 min';
  }
  if (minutes < 60) {
    return `${String(minutes)} min`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest).padStart(2, '0')}`;
}

/** `8:40 PM` — same shape the producer already uses for the weekly reset. */
function formatClock(epochSeconds: number): string {
  try {
    return new Date(epochSeconds * 1000).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  } catch {
    return '';
  }
}

function formatK(tokens: number): string {
  // A 1M context window would read as "1000k" otherwise
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    const rounded = millions.toFixed(1);
    return rounded.endsWith('.0') ? `${rounded.slice(0, -2)}M` : `${rounded.replace('.', ',')}M`;
  }

  const value = tokens / 1000;
  const fraction = value - Math.floor(value);
  if (value >= 100 || fraction < 0.05 || fraction > 0.95) {
    return `${String(Math.round(value))}k`;
  }
  return `${value.toFixed(1).replace('.', ',')}k`;
}

// Main webview context class
class WebviewContext {
  /** How long a fresh tab's size has to hold still before it is reported to the host. */
  private static readonly READY_SETTLE_MS = 80;

  readonly state = new TerminalState();
  private readonly themeBuilder = new ThemeBuilder();
  private readonly vscode: VSCodeAPI;
  private readonly tabBar: HTMLElement;
  private readonly terminalsContainer: HTMLElement;
  private readonly statusLine: StatusLineView;
  private readonly tooltips = new TooltipManager();
  private resizeObserver: ResizeObserver | null = null;
  private themeObserver: MutationObserver | null = null;
  private themeApplyTimer: number | null = null;

  constructor() {
    this.vscode = acquireVsCodeApi();

    const tabBar = document.getElementById('tab-bar');
    const terminalsContainer = document.getElementById('terminals-container');
    const statusLineElement = document.getElementById('status-line');

    if (!tabBar || !terminalsContainer || !statusLineElement) {
      throw new Error('Required DOM elements not found');
    }

    this.tabBar = tabBar;
    this.terminalsContainer = terminalsContainer;
    // Showing or hiding a row changes the terminal's height, so xterm has to refit.
    this.statusLine = new StatusLineView(
      statusLineElement,
      () => {
        this.refitActive();
      },
      () => {
        this.postMessage({ type: 'insertEditorReference' });
      },
      () => {
        const id = this.state.getActiveId();
        if (id) {
          this.postMessage({ type: 'stopTurn', id });
        }
      },
      (value) => {
        this.postMessage({ type: 'setContextThreshold', value });
      },
      this.tooltips
    );
  }

  setContextThreshold(value: number): void {
    this.statusLine.setThreshold(value);
  }

  setStatusLine(id: string, snapshot: StatusLineSnapshot | null): void {
    this.statusLine.set(id, snapshot);
  }

  setEditorContext(context: EditorContext | null): void {
    this.statusLine.setEditorContext(context);
  }

  /**
   * Puts the caret in the terminal. Focusing the view only gets as far as the webview; xterm
   * listens on its own hidden textarea, and without this the keystrokes go nowhere — or worse,
   * stay in the editor the reference was taken from.
   *
   * Deferred by a frame: VS Code is still moving focus to the view when this arrives.
   */
  focusActiveTerminal(): void {
    const activeId = this.state.getActiveId();
    const active = activeId ? this.state.get(activeId) : undefined;
    if (!active) return;

    requestAnimationFrame(() => {
      active.terminal.focus();
    });
  }

  private refitActive(): void {
    const activeId = this.state.getActiveId();
    const active = activeId ? this.state.get(activeId) : undefined;
    if (!active || !activeId) return;

    requestAnimationFrame(() => {
      active.fitAddon.fit();
      this.postMessage({
        type: 'resize',
        id: activeId,
        cols: active.terminal.cols,
        rows: active.terminal.rows
      });
    });
  }

  initialize(): void {
    this.setupResizeObserver();
    this.setupThemeObserver();
    this.setupMessageHandler();
    this.setupCleanup();
    this.signalReady();
  }

  /**
   * Keeps the terminals on the current VS Code theme. xterm takes finished colour values, not
   * CSS variables, so its theme is a snapshot and has to be handed over again on every change.
   * VS Code rewrites the `--vscode-*` variables while the theme picker is merely highlighted,
   * so this follows along live rather than only on confirmation.
   */
  private setupThemeObserver(): void {
    this.themeObserver = new MutationObserver(() => {
      // A single theme change writes the attributes several times
      if (this.themeApplyTimer !== null) {
        clearTimeout(this.themeApplyTimer);
      }
      this.themeApplyTimer = setTimeout(() => {
        this.themeApplyTimer = null;
        this.applyTheme();
      }, 50) as unknown as number;
    });

    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style']
    });
    this.themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'style']
    });
  }

  private applyTheme(): void {
    this.themeBuilder.invalidateCache();
    const theme = this.themeBuilder.getTheme();
    const fontFamily = this.themeBuilder.getFontFamily();

    this.state.forEach((entry) => {
      entry.terminal.options.theme = theme;
      entry.terminal.options.fontFamily = fontFamily;
    });

    // A different font family changes the cell size, so the column count can change with it
    this.refitActive();

    // The new background is now live in every xterm. Only from here on is it safe for the host to
    // poke OpenCode tabs (which re-query the palette for their theme mode); kicking earlier would
    // race this 50 ms sample delay and flip them against the still-stale background.
    this.postMessage({ type: 'themeApplied' });
  }

  private setupResizeObserver(): void {
    this.resizeObserver = new ResizeObserver(() => {
      const activeId = this.state.getActiveId();
      if (activeId) {
        const active = this.state.get(activeId);
        if (active) {
          const wasAtBottom = ScrollManager.isAtBottom(active.terminal);
          const viewport = active.element.querySelector('.xterm-viewport') as HTMLElement;
          const savedScrollTop = viewport?.scrollTop ?? 0;

          active.fitAddon.fit();
          this.scheduleReadyReport(activeId, active);

          requestAnimationFrame(() => {
            if (wasAtBottom) {
              active.terminal.scrollToBottom();
            } else if (viewport && savedScrollTop > 0) {
              viewport.scrollTop = savedScrollTop;
            }
            active.isAtBottom = wasAtBottom;
          });

          this.postMessage({
            type: 'resize',
            id: activeId,
            cols: active.terminal.cols,
            rows: active.terminal.rows
          });
        }
      }
    });
    this.resizeObserver.observe(this.terminalsContainer);
  }

  private setupMessageHandler(): void {
    window.addEventListener('message', (event: MessageEvent<WebviewIncomingMessage>) => {
      const message = event.data;
      const handler = messageHandlers[message.type] as MessageHandler<typeof message> | undefined;
      if (handler) {
        handler(message, this);
      }
    });
  }

  private setupCleanup(): void {
    window.addEventListener('unload', () => {
      this.resizeObserver?.disconnect();
      this.themeObserver?.disconnect();
      if (this.themeApplyTimer !== null) {
        clearTimeout(this.themeApplyTimer);
      }
      this.state.forEach((t) => {
        t.terminal.dispose();
      });
    });
  }

  private signalReady(): void {
    const { cols, rows } = this.measureInitialDimensions();
    this.postMessage({ type: 'ready', cols, rows });
  }

  private measureInitialDimensions(): { cols: number; rows: number } {
    const tempContainer = document.createElement('div');
    tempContainer.style.cssText =
      // 36px is the vertical tab bar; the terminal wrapper itself has no padding
      'position: absolute; visibility: hidden; width: calc(100% - 36px); height: 100%;';
    document.body.appendChild(tempContainer);

    const tempTerminal = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: this.themeBuilder.getFontFamily(),
      lineHeight: 1.2
    });
    const tempFitAddon = new FitAddon();
    tempTerminal.loadAddon(tempFitAddon);
    tempTerminal.open(tempContainer);
    tempFitAddon.fit();

    const cols = tempTerminal.cols;
    const rows = tempTerminal.rows;

    tempTerminal.dispose();
    tempContainer.remove();

    return { cols, rows };
  }

  postMessage(message: WebviewOutgoingMessage): void {
    this.vscode.postMessage(message);
  }

  renderTabBar(tabsList: TabInfo[]): void {
    this.tabBar.innerHTML = '';

    tabsList.forEach((tab, index) => {
      const tabElement = this.createTabElement(tab, index);
      this.tabBar.appendChild(tabElement);
    });

    const addButton = this.createAddButton();
    this.tabBar.appendChild(addButton);

    const customCmdButton = this.createCustomCommandButton();
    this.tabBar.appendChild(customCmdButton);
  }

  private createTabElement(tab: TabInfo, index: number): HTMLDivElement {
    const tabElement = document.createElement('div');
    tabElement.className = `tab ${tab.isActive ? 'active' : ''}`;
    tabElement.dataset.id = tab.id;
    // Show the engine and the working directory: Claude Code keeps its session history per
    // directory, so a tab in an unexpected folder shows an unexpected /resume list.
    const engineLabel = tab.engine === 'opencode' ? 'OpenCode' : 'Claude';
    tabElement.dataset.tooltip = tab.cwd
      ? `${tab.name} — ${engineLabel} — ${tab.cwd}`
      : `${tab.name} — ${engineLabel}`;

    // Apply accent color if provided (for multi-workspace folder coloring)
    if (tab.accentColor) {
      tabElement.dataset.accent = 'true';
      tabElement.style.borderLeftColor = tab.accentColor;
    }

    const nameSpan = document.createElement('span');
    nameSpan.className = 'tab-name';
    nameSpan.textContent = String(index + 1);

    const closeButton = document.createElement('button');
    closeButton.className = 'tab-close';
    closeButton.dataset.tooltip = 'Close Tab (Cmd+W)';
    closeButton.onclick = (e) => {
      e.stopPropagation();
      this.postMessage({ type: 'closeTab', id: tab.id });
    };

    tabElement.onclick = () => {
      if (!tab.isActive) {
        this.postMessage({ type: 'switchTab', id: tab.id });
      }
    };

    tabElement.appendChild(nameSpan);
    tabElement.appendChild(closeButton);

    // Add notification pill if waiting for input
    if (tab.isWaitingForInput) {
      const pill = document.createElement('span');
      pill.className = 'notification-pill';
      tabElement.appendChild(pill);
    }

    return tabElement;
  }

  private createAddButton(): HTMLButtonElement {
    const addButton = document.createElement('button');
    addButton.className = 'tab-add';
    addButton.innerHTML = '+';
    addButton.dataset.tooltip = 'New Terminal (Cmd+Shift+`)';
    addButton.onclick = () => {
      this.postMessage({ type: 'newTab' });
    };
    return addButton;
  }

  private createCustomCommandButton(): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'tab-add';
    button.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="display: block; margin: auto;">
      <path d="M1 3.5L4.5 7 1 10.5v1.12l4.5-4.5v-.24L1 2.38V3.5zm5 9h9v-1H6v1z"/>
      <path d="M11 3v2H9v1h2v2h1V6h2V5h-2V3h-1z"/>
    </svg>`;
    button.dataset.tooltip = 'New Terminal with Custom Command';
    button.onclick = () => {
      this.postMessage({ type: 'newTabWithCommand' });
    };
    return button;
  }

  createTerminalElement(id: string): TerminalEntry {
    const container = document.createElement('div');
    container.className = 'terminal-wrapper';
    container.id = `terminal-${id}`;
    // `visibility`, not `display`: the wrapper is absolutely positioned over the whole container,
    // so it has a box to measure while painting nothing. Opened under `display: none` the box is
    // 0x0 — measured — and xterm keeps its 80x24 default until some later fit, which is what put
    // the CLI's first frame into a window of the wrong size.
    container.style.visibility = 'hidden';
    this.terminalsContainer.appendChild(container);

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: this.themeBuilder.getFontFamily(),
      lineHeight: 1.2,
      letterSpacing: 0,
      theme: this.themeBuilder.getTheme(),
      allowProposedApi: true
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(container);

    // Register file path link provider
    const fileLinkProvider = new FileLinkProvider(terminal, id, this.postMessage.bind(this));
    terminal.registerLinkProvider(fileLinkProvider);

    const entry: TerminalEntry = {
      terminal,
      fitAddon,
      element: container,
      isAtBottom: true,
      lastScrollTop: 0
    };

    terminal.onData((data) => {
      entry.isAtBottom = true;
      this.postMessage({ type: 'input', id, data });
    });

    ScrollManager.setupScrollTracking(entry);
    this.state.set(id, entry);

    // Fit right away, so nothing can land in an 80x24 default buffer, then let the report
    // settle: the status line and the editor row arrive in the messages right behind `createTab`
    // and take up to seven rows off the terminal's height.
    fitAddon.fit();
    this.scheduleReadyReport(id, entry);

    requestAnimationFrame(() => {
      // Showing the tab is `switchToTerminal`'s job; everything else goes back to hidden.
      if (this.state.getActiveId() !== id) {
        container.style.display = 'none';
      }
      container.style.visibility = '';
    });

    return entry;
  }

  /**
   * Reports the tab's measured size to the host, once, after it has stopped moving.
   *
   * The host holds the process until this arrives, so the number has to be the height the
   * terminal keeps — not the one it has for the two frames before the status line appears. Every
   * fit restarts the timer; the first quiet moment wins. The host starts the process anyway after
   * two seconds, so a dropped report costs a resize, not a dead tab.
   */
  private scheduleReadyReport(id: string, entry: TerminalEntry): void {
    if (entry.readySent) {
      return;
    }
    if (entry.readyTimer !== undefined) {
      window.clearTimeout(entry.readyTimer);
    }
    entry.readyTimer = window.setTimeout(() => {
      entry.readyTimer = undefined;
      entry.readySent = true;
      this.postMessage({
        type: 'terminalReady',
        id,
        cols: entry.terminal.cols,
        rows: entry.terminal.rows
      });
    }, WebviewContext.READY_SETTLE_MS);
  }

  switchToTerminal(id: string): void {
    this.state.forEach((t, tid) => {
      t.element.style.display = tid === id ? 'block' : 'none';
      // A tab can still be in its measuring pass, where the wrapper is hidden but laid out.
      // Without this the freshly activated terminal would have `display: block` and stay
      // invisible until the next thing happened to clear it.
      t.element.style.visibility = '';
    });

    this.state.setActiveId(id);
    this.statusLine.setActive(id);

    const active = this.state.get(id);
    if (active) {
      const wasAtBottom = active.isAtBottom;
      const savedScrollTop = active.lastScrollTop;

      // Double RAF ensures browser has completed layout after display change
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          active.fitAddon.fit();
          this.scheduleReadyReport(id, active);
          active.terminal.focus();

          requestAnimationFrame(() => {
            if (wasAtBottom) {
              active.terminal.scrollToBottom();
            } else {
              const viewport = active.element.querySelector('.xterm-viewport') as HTMLElement;
              if (viewport && savedScrollTop > 0) {
                viewport.scrollTop = savedScrollTop;
              }
            }
          });

          this.postMessage({
            type: 'resize',
            id,
            cols: active.terminal.cols,
            rows: active.terminal.rows
          });
        });
      });
    }
  }

  removeTerminal(id: string): void {
    const t = this.state.get(id);
    if (t) {
      t.terminal.dispose();
      t.element.remove();
      this.state.delete(id);
    }
    this.statusLine.remove(id);
  }

  setTabNotification(id: string, show: boolean): void {
    const tab = this.tabBar.querySelector(`.tab[data-id="${id}"]`);
    if (!tab) return;

    let pill = tab.querySelector('.notification-pill');
    if (show && !pill) {
      pill = document.createElement('span');
      pill.className = 'notification-pill';
      tab.appendChild(pill);
    } else if (!show && pill) {
      pill.remove();
    }
  }
}

// Entry point
(function () {
  try {
    const ctx = new WebviewContext();
    ctx.initialize();
  } catch (error) {
    console.error('Failed to initialize webview:', error);
  }
})();
