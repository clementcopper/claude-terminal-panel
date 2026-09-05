import { Terminal, type ILinkProvider, type ILink } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type {
  VSCodeAPI,
  WebviewIncomingMessage,
  WebviewOutgoingMessage,
  TabInfo,
  GroupInfo,
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
          // `end.x` is inclusive and 1-based; `pathEnd` is already the exclusive 0-based end.
          end: { x: pathEnd, y: bufferLineNumber }
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

    // One stack for the terminal, declared in `styles.css` next to the UI one. It already starts
    // with SF Mono and ends in VS Code's own editor font, so reading the variable keeps the two
    // halves of the panel from drifting apart.
    const monoFont = this.getCssVar('--panel-mono-font', '');
    this.cachedFontFamily = monoFont || ThemeBuilder.DEFAULT_FONT_FAMILY;

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
      // Without these three xterm draws its slider from the foreground at 20% opacity, which is
      // its own grey rather than the one every other scrollbar in the window uses.
      scrollbarSliderBackground: this.getCssVar(
        '--vscode-scrollbarSlider-background',
        'rgba(121, 121, 121, 0.4)'
      ),
      scrollbarSliderHoverBackground: this.getCssVar(
        '--vscode-scrollbarSlider-hoverBackground',
        'rgba(100, 100, 100, 0.7)'
      ),
      scrollbarSliderActiveBackground: this.getCssVar(
        '--vscode-scrollbarSlider-activeBackground',
        'rgba(191, 191, 191, 0.4)'
      ),
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
      this.markScrollback(entry);
    });

    // xterm hard-codes its vertical scrollbar to VS Code's "auto" visibility, which fades the bar
    // out about a second after the last scroll — so a terminal at rest never shows one. CSS pins
    // it back on, but only under this class: with nothing to scroll the widget still draws a
    // slider, and it fills the whole track, which would leave a permanent grey strip down the
    // edge of every idle terminal.
    entry.terminal.onRender(() => {
      this.markScrollback(entry);
    });
    this.markScrollback(entry);

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

  /** `baseY` is how many rows have scrolled off the top — zero means there is nothing above. */
  private static markScrollback(entry: TerminalEntry): void {
    entry.element.classList.toggle('has-scrollback', entry.terminal.buffer.active.baseY > 0);
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
      // The process has spoken — including when what it says is that it exited. Either way the
      // waiting is over and the indicator must not sit on top of the answer.
      ctx.clearStartupIndicator(t);
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
  groupsUpdate: (message, ctx) => {
    ctx.renderGroupBar(message.groups);
  },
  createTab: (message, ctx) => {
    ctx.createTerminalElement(message.id, message.name, message.awaitingStart);
  },
  startTerminal: (message, ctx) => {
    ctx.startRestoredTerminal(message.id);
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
  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'panel-tooltip';
    this.element.hidden = true;
    document.body.appendChild(this.element);

    // Delegated, because tabs are rebuilt on every update — per-element listeners would have to
    // be reattached each time.
    document.addEventListener('mouseover', (event) => {
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

  private hide(): void {
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
  /** Every ring reads the same: first third of the fill blue, second orange, last red. Measured
      on the fill, not on the raw percentage — the context ring fills against the threshold, so
      these are fractions of that budget rather than of a full window. */
  private static readonly RING_WARN_FRACTION = 0.6;
  private static readonly RING_DANGER_FRACTION = 0.8;
  /** The compaction ring counts rather than fills: the second segment warns, the third is red,
      whatever the budget behind it. A count of compactions is small enough to read as a count. */
  private static readonly COMP_WARN_SEGMENTS = 2;
  private static readonly COMP_DANGER_SEGMENTS = 3;
  /** The slider cannot be dragged to the very ends — a threshold of 0 or 100 says nothing. */
  private static readonly MIN_THRESHOLD_PCT = 5;
  private static readonly MAX_THRESHOLD_PCT = 95;
  /** Nothing written for this long means Claude has not re-rendered since. */
  private static readonly STALE_AFTER_MS = 60_000;
  /** Redraw cadence for the reset countdown while no snapshot arrives. */
  private static readonly TICK_MS = 30_000;
  /** At this point the bucket is gone, not merely close — see `onCredits`. */
  private static readonly LIMIT_SPENT_PCT = 100;

  private static readonly SVG_NS = 'http://www.w3.org/2000/svg';
  /**
   * Ring geometry, from the design frame. 16.38 + half of 3.24 is exactly 18, so the stroke
   * fills the 36px box to its edge and nothing is clipped. The arc spans 300° from 120°,
   * clockwise, which leaves the 60° gap centred at the bottom.
   */
  private static readonly RING_R = 16.38;
  private static readonly RING_STROKE = 3.24;
  private static readonly RING_START_DEG = 120;
  private static readonly RING_SPAN_DEG = 300;
  private static readonly RING_C = 2 * Math.PI * StatusLineView.RING_R;
  /**
   * Gap between the compaction ring's segments; the segments share what is left of the span.
   *
   * 21°, not the 14° the geometry would suggest: the round caps every arc here uses grow the
   * stroke by half its width at each end, which is 5.7° at this radius. Two of those swallow
   * 11.3°, so a 14° gap rendered as 2.7° — 0.8px — and the three segments read as one unbroken
   * track. 21° leaves 9.7°, and the caps stay round like the other three rings.
   */
  private static readonly COMP_GAP_DEG = 21;
  /** Past this the segments are thinner than their own round caps and read as noise. */
  private static readonly COMP_MAX_SEGMENTS = 5;
  private static readonly COMP_DEFAULT_BUDGET = 3;

  /** Below this panel width the row stays left-aligned even when it happens to fit on one line. */
  private static readonly CENTER_MIN_PANEL_PX = 400;

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

  constructor(
    private readonly element: HTMLElement,
    private readonly onHeightChange: () => void,
    private readonly onEditorReferenceClick: () => void,
    private readonly onStopTurn: () => void,
    private readonly onThresholdPrompt: () => void
  ) {
    // Centring is a measurement, not a breakpoint, so it has to be taken again whenever the panel
    // changes width — a resize on its own never rebuilds the row. Toggling `justify-content`
    // changes neither the wrap nor the height, so this cannot feed itself.
    new ResizeObserver(() => this.updateCentering()).observe(element);
  }

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
   * Measured rather than inferred from `hidden`: a row can come and go while the element stays
   * visible — the editor row appears the moment a file is opened, the rings wrap onto a second
   * line when the panel narrows — and each of those moves the terminal's bottom edge just as
   * much as showing the status line does. Without the refit xterm keeps its old row count.
   */
  private render(): void {
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

    this.element.appendChild(this.buildMainRow(snapshot));

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

    this.updateCentering();
  }

  /**
   * Centres the main row once it fits on one line.
   *
   * The condition is measured rather than derived from a width: the row wraps at whatever width
   * its own contents need, and that moves with the UI font and with the length of the effort
   * badge. Reconstructing the threshold from the tab bar and the padding would be the same
   * mistake `measureInitialDimensions` once made.
   *
   * The panel width is the second half of the condition, because a snapshot carrying a single
   * ring fits on one line in a narrow panel too, and centring it there is not what the frame
   * shows. Only this row: the file and the directory keep the left edge.
   */
  private updateCentering(): void {
    const row = this.element.querySelector<HTMLElement>('.status-row.main');
    if (!row) return;

    const items = Array.from(row.children) as HTMLElement[];
    const oneLine =
      items.length > 0 && items.every((item) => item.offsetTop === items[0].offsetTop);
    const centered = oneLine && document.body.clientWidth > StatusLineView.CENTER_MIN_PANEL_PX;

    if (centered !== row.classList.contains('centered')) {
      row.classList.toggle('centered', centered);
    }
  }

  /**
   * The stop button, at the head of the main row.
   *
   * It sits in the flow rather than in a corner: it is the only control besides the context ring,
   * and the row it leads is the one that says how the turn is going. Fixed 36px disc so the row's
   * height is a constant — a control that grows with its content would move the terminal's bottom
   * edge.
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
    const svg = document.createElementNS(StatusLineView.SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 11 11');
    svg.setAttribute('aria-hidden', 'true');
    const shape = document.createElementNS(StatusLineView.SVG_NS, 'rect');
    shape.setAttribute('width', '11');
    shape.setAttribute('height', '11');
    shape.setAttribute('rx', '2');
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
   * One 300° arc in a 36px box, drawn as a dashed `<circle>` rather than as computed path data.
   *
   * A circle carries any fill level through `stroke-dashoffset` alone, with no trigonometry and
   * no rounding drift at the ends. `rotate(120)` puts the dash start at the design's start point
   * (9.81, 32.19) and the dash runs clockwise from there, leaving the 60° gap centred at the
   * bottom. `fraction` is 0…1 of the arc, not of the circle.
   */
  private buildArc(
    fraction: number,
    className: string,
    startDeg = StatusLineView.RING_START_DEG,
    spanDeg = StatusLineView.RING_SPAN_DEG
  ): SVGCircleElement {
    const circle = document.createElementNS(StatusLineView.SVG_NS, 'circle');
    circle.setAttribute('class', className);
    circle.setAttribute('cx', '18');
    circle.setAttribute('cy', '18');
    circle.setAttribute('r', String(StatusLineView.RING_R));
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke-width', String(StatusLineView.RING_STROKE));
    circle.setAttribute('stroke-linecap', 'round');
    circle.setAttribute('stroke-dasharray', String(StatusLineView.RING_C));
    circle.setAttribute('transform', `rotate(${String(startDeg)} 18 18)`);

    const span = (StatusLineView.RING_C * spanDeg) / 360;
    const clamped = Math.min(1, Math.max(0, fraction));
    circle.setAttribute('stroke-dashoffset', String(StatusLineView.RING_C - clamped * span));
    return circle;
  }

  /**
   * One level for the rings that fill, read off how full they are: nothing below 60%, warn from
   * there, danger from 80%. Ring and number take the same name, so the two halves of one control
   * can never disagree. The compaction ring counts instead — see `segmentLevel`.
   */
  private static ringLevel(fraction: number): string {
    if (fraction >= StatusLineView.RING_DANGER_FRACTION) return ' danger';
    if (fraction >= StatusLineView.RING_WARN_FRACTION) return ' warn';
    return '';
  }

  /**
   * The compaction ring's level, off the count rather than off a fraction: one compaction is
   * normal, two are worth noticing, three are the point. A fraction would move that line with
   * the budget, and the number being judged here is the count itself.
   */
  private static segmentLevel(filled: number): string {
    if (filled >= StatusLineView.COMP_DANGER_SEGMENTS) return ' danger';
    if (filled >= StatusLineView.COMP_WARN_SEGMENTS) return ' warn';
    return '';
  }

  /** The 36px disc: track, fill, and the number that sits in the hole. */
  private buildRing(fraction: number, value: string, level: string): HTMLSpanElement {
    const ring = document.createElement('span');
    ring.className = 'status-ring';

    const svg = document.createElementNS(StatusLineView.SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 36 36');
    svg.setAttribute('aria-hidden', 'true');
    svg.appendChild(this.buildArc(1, 'status-ring-track'));
    svg.appendChild(this.buildArc(fraction, `status-ring-fill${level}`));
    ring.appendChild(svg);

    const label = document.createElement('span');
    // Four characters ("100%") touch the arc at the design's 10px, so that one step goes smaller
    label.className = `status-ring-value${level}${value.length > 3 ? ' small' : ''}`;
    label.textContent = value;
    ring.appendChild(label);

    return ring;
  }

  /**
   * The compaction ring: one segment per budgeted compaction rather than one continuous arc, so
   * the count is readable without the number. The gap between segments is fixed and the segments
   * share what is left of the 300°.
   */
  private buildSegmentRing(filled: number, total: number, value: string): HTMLSpanElement {
    const count = Math.min(StatusLineView.COMP_MAX_SEGMENTS, Math.max(1, Math.round(total)));
    const gap = StatusLineView.COMP_GAP_DEG;
    const segment = (StatusLineView.RING_SPAN_DEG - (count - 1) * gap) / count;

    const level = StatusLineView.segmentLevel(filled);

    const ring = document.createElement('span');
    ring.className = 'status-ring';

    const svg = document.createElementNS(StatusLineView.SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 36 36');
    svg.setAttribute('aria-hidden', 'true');
    for (let index = 0; index < count; index += 1) {
      const start = StatusLineView.RING_START_DEG + index * (segment + gap);
      const isFilled = index < filled;
      svg.appendChild(
        this.buildArc(
          1,
          isFilled ? `status-ring-fill${level}` : 'status-ring-track',
          start,
          segment
        )
      );
    }
    ring.appendChild(svg);

    const label = document.createElement('span');
    label.className = `status-ring-value${level}${value.length > 3 ? ' small' : ''}`;
    label.textContent = value;
    ring.appendChild(label);

    return ring;
  }

  /** Ring plus its two-line label. `name` sits above the value the ring cannot show. */
  private buildRingGroup(
    key: string,
    ring: HTMLSpanElement,
    name: string,
    sub: string,
    tooltip?: string
  ): HTMLDivElement {
    const group = document.createElement('div');
    group.className = `status-ring-group ${key}`;
    if (tooltip !== undefined) {
      group.dataset.tooltip = tooltip;
    }
    group.appendChild(ring);

    const label = document.createElement('span');
    label.className = 'status-ring-label';

    const nameEl = document.createElement('span');
    nameEl.className = 'status-ring-name';
    nameEl.textContent = name;
    label.appendChild(nameEl);

    if (sub.length > 0) {
      const subEl = document.createElement('span');
      subEl.className = 'status-ring-sub';
      subEl.textContent = sub;
      label.appendChild(subEl);
    }

    group.appendChild(label);
    return group;
  }

  /**
   * The row that carries everything but the file and the directory: stop, model, and the four
   * rings. The rings wrap as a group when the panel is too narrow for them — the panel is
   * resizable and narrow by nature, and a ring that fell off the right edge would be worse than
   * a taller row.
   */
  private buildMainRow(snapshot: StatusLineSnapshot): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'status-row main';

    const head = document.createElement('div');
    head.className = 'status-head';
    head.appendChild(this.buildStopButton());

    if (snapshot.model || snapshot.effort) {
      const text = document.createElement('div');
      text.className = 'status-head-text';
      if (snapshot.model) {
        const model = document.createElement('span');
        model.className = 'status-model';
        model.textContent = snapshot.model;
        text.appendChild(model);
      }
      if (snapshot.effort) {
        const effort = document.createElement('span');
        effort.className = 'status-effort';
        effort.textContent = snapshot.effort;
        text.appendChild(effort);
      }
      head.appendChild(text);
    }
    row.appendChild(head);

    // Straight into the row, not into a container of their own: a container is one flex item, so
    // the whole set of rings dropped to the next line together and left the stop button sitting
    // alone on the first one. As siblings they wrap one at a time, and the stop button keeps the
    // head of the first line whatever the width.
    for (const group of this.buildRingGroups(snapshot)) {
      row.appendChild(group);
    }

    return row;
  }

  private buildRingGroups(snapshot: StatusLineSnapshot): HTMLDivElement[] {
    const groups: HTMLDivElement[] = [];

    // A five-hour bucket at 100% is not "nearly full", it is spent, and the turns going through
    // are billed to usage credits — so the label says which bucket the ring is showing.
    const onCredits =
      snapshot.sessionPercent !== undefined &&
      snapshot.sessionPercent >= StatusLineView.LIMIT_SPENT_PCT;
    // The weekly bucket is a separate question with a separate answer; it used to share this
    // name, which made the two impossible to tell apart at the call site.
    const weekSpent =
      snapshot.weekPercent !== undefined && snapshot.weekPercent >= StatusLineView.LIMIT_SPENT_PCT;

    const ctx = this.buildContextGroup(snapshot);
    if (ctx) groups.push(ctx);

    const session = this.buildSessionGroup(snapshot, onCredits);
    if (session) groups.push(session);

    if (snapshot.weekPercent !== undefined) {
      const percent = Math.round(snapshot.weekPercent);
      const level = StatusLineView.ringLevel(snapshot.weekPercent / 100);
      const tooltip = [
        snapshot.weekResetsAt ? `Weekly limit resets on ${snapshot.weekResetsAt}` : '',
        weekSpent ? 'Weekly limit spent — turns run on usage credits' : ''
      ]
        .filter((line) => line.length > 0)
        .join('\n');
      groups.push(
        this.buildRingGroup(
          'week',
          this.buildRing(snapshot.weekPercent / 100, `${String(percent)}%`, level),
          'Week',
          snapshot.weekResetsAt ?? '',
          tooltip.length > 0 ? tooltip : undefined
        )
      );
    }

    if (snapshot.compacted !== undefined) {
      const budget = snapshot.compactBudget ?? StatusLineView.COMP_DEFAULT_BUDGET;
      const auto = snapshot.compactAuto ?? 0;
      groups.push(
        this.buildRingGroup(
          'comp',
          this.buildSegmentRing(snapshot.compacted, budget, String(snapshot.compacted)),
          'Comp',
          `${String(auto)} auto`,
          `Compacted ${String(snapshot.compacted)} of ${String(budget)} · ${String(auto)} automatic`
        )
      );
    }

    return groups;
  }

  /**
   * The context ring fills against the threshold, not against a full window: the threshold is
   * the point the row exists to warn about, so a full ring and the red are the same event. The
   * number in the hole stays the absolute percentage — that is the value being judged.
   *
   * A tab Claude has not rendered yet carries no numbers, and shows no ring rather than an empty
   * one reading "0 / 0". The stop button beside it stays either way.
   */
  private buildContextGroup(snapshot: StatusLineSnapshot): HTMLDivElement | null {
    if (snapshot.totalTokens <= 0) {
      return null;
    }

    // Fractions of the fill, and the fill runs against the threshold — so with a threshold of 60
    // the ring turns orange at 36 points of the window and red at 48.
    const level = StatusLineView.ringLevel(snapshot.usedPercent / this.threshold);
    const percent = Math.round(snapshot.usedPercent);
    const budget = (snapshot.totalTokens * this.threshold) / 100;
    // The ring fills against the threshold, so the number counts against it too — otherwise the
    // two halves of the same control say different things. Not capped at 100: past the threshold
    // the ring can only stand full, and how far past is exactly what is worth knowing. The
    // absolute percentage and the token counts are in the tooltip.
    const ofThreshold = Math.round((snapshot.usedPercent / this.threshold) * 100);

    const ring = this.buildRing(
      snapshot.usedPercent / this.threshold,
      `${String(ofThreshold)}%`,
      level
    );

    const group = this.buildRingGroup(
      'ctx',
      ring,
      'Ctx',
      formatK(budget),
      `${String(percent)}% of the window · ${formatK(snapshot.usedTokens)} / ${formatK(snapshot.totalTokens)}\nThreshold ${String(this.threshold)}% — click to change`
    );

    // The ring is the only threshold control left, so it has to be reachable by keyboard and
    // has to say what it is. A click carries no value; the host asks for one.
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'status-ring-button';
    button.setAttribute('aria-label', `Context threshold, ${String(this.threshold)}%`);
    button.addEventListener('click', () => {
      this.onThresholdPrompt();
    });
    group.replaceChild(button, ring);
    button.appendChild(ring);

    return group;
  }

  private buildSessionGroup(
    snapshot: StatusLineSnapshot,
    onCredits: boolean
  ): HTMLDivElement | null {
    if (snapshot.sessionPercent === undefined) {
      return null;
    }

    // Prefer the absolute point: a remembered "84 min" is wrong an hour later
    const resetsAt = snapshot.sessionResetsAt;
    const remainingMs = resetsAt !== undefined ? resetsAt * 1000 - Date.now() : undefined;
    const minutes =
      remainingMs !== undefined ? Math.round(remainingMs / 60000) : snapshot.sessionResetsInMin;

    // Past the reset point the percentage describes a window that no longer exists — the watcher
    // drops it for the same reason when it fills a fresh tab from memory. Measured against the
    // point itself, not against the rounded minutes: rounding calls anything under 30 seconds
    // zero, which would blank the label in its last half minute.
    const expired = remainingMs !== undefined && remainingMs <= 0;
    const percent = Math.round(snapshot.sessionPercent);
    // Credits beat the fill: past the bucket the ring can only stand full, and that is danger
    // whatever the arithmetic says.
    const level = onCredits ? ' danger' : StatusLineView.ringLevel(snapshot.sessionPercent / 100);

    const sub = expired
      ? 'Limit reset'
      : minutes !== undefined
        ? formatRemaining(minutes)
        : resetsAt !== undefined
          ? formatClock(resetsAt)
          : '';

    const tooltip = [
      onCredits ? 'Session limit spent — turns run on usage credits' : '',
      resetsAt !== undefined && !expired ? `Session limit resets at ${formatClock(resetsAt)}` : ''
    ]
      .filter((line) => line.length > 0)
      .join('\n');

    return this.buildRingGroup(
      'sess',
      this.buildRing(snapshot.sessionPercent / 100, `${String(percent)}%`, level),
      onCredits ? 'Credits' : 'Sess',
      sub,
      tooltip.length > 0 ? tooltip : undefined
    );
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

  /** Grace period before a starting tab admits that it is starting. */
  private static readonly STARTUP_INDICATOR_DELAY_MS = 250;

  readonly state = new TerminalState();
  private readonly themeBuilder = new ThemeBuilder();
  private readonly vscode: VSCodeAPI;
  private readonly tabBar: HTMLElement;
  private readonly groupBar: HTMLElement;
  /** The group whose tab is currently being renamed inline, and the text typed so far. */
  private renamingGroupId: string | null = null;
  private renameDraft: string | null = null;
  /** The active group's CLI, so the inner `+` can say which one it will open. */
  private activeGroupEngine: 'claude' | 'opencode' = 'claude';
  private readonly terminalsContainer: HTMLElement;
  private readonly statusLine: StatusLineView;
  private readonly tooltips = new TooltipManager();
  private resizeObserver: ResizeObserver | null = null;
  private themeObserver: MutationObserver | null = null;
  private themeApplyTimer: number | null = null;

  constructor() {
    this.vscode = acquireVsCodeApi();

    const tabBar = document.getElementById('tab-bar');
    const groupBar = document.getElementById('group-bar');
    const terminalsContainer = document.getElementById('terminals-container');
    const statusLineElement = document.getElementById('status-line');

    if (!tabBar || !groupBar || !terminalsContainer || !statusLineElement) {
      throw new Error('Required DOM elements not found');
    }

    this.tabBar = tabBar;
    this.groupBar = groupBar;
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
      () => {
        this.postMessage({ type: 'promptContextThreshold' });
      }
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

  /**
   * Measures against a throwaway `.terminal-wrapper` inside the real `#terminals-container`,
   * rather than reconstructing that box from the viewport.
   *
   * FitAddon measures the wrapper, so this is the same box a real tab gets — with the vertical
   * tab bar, the group bar and the wrapper's own 10px/6px insets already taken out by the CSS
   * that owns them. The old arithmetic hardcoded the tab bar's 36px, knew nothing about the
   * group bar and ignored the insets; measured at a 320px panel it reported 35 rows where the
   * real wrapper fits 33.
   *
   * The status line is still not in it — it is hidden at this point and appears later, which is
   * why `StatusLineView` triggers a refit when it changes height.
   */
  private measureInitialDimensions(): { cols: number; rows: number } {
    const tempContainer = document.createElement('div');
    tempContainer.className = 'terminal-wrapper';
    tempContainer.style.visibility = 'hidden';
    this.terminalsContainer.appendChild(tempContainer);

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

  /**
   * The outer bar: the group tabs, then the `+` behind them — the same order `renderTabBar` uses
   * for the inner bar. The button is sticky against the right edge, so a row of groups too wide
   * for a narrow panel scrolls under it instead of pushing it out of reach.
   */
  renderGroupBar(groups: GroupInfo[]): void {
    this.groupBar.innerHTML = '';

    const closable = groups.length > 1;
    groups.forEach((group) => {
      this.groupBar.appendChild(this.createGroupElement(group, closable));
    });

    this.groupBar.appendChild(this.createGroupAddButton());

    // The inner `+` opens a terminal of the active group's CLI, so its tooltip has to follow the
    // group. `tabsUpdate` is sent before `groupsUpdate`, so the button already exists here and is
    // relabelled in place rather than waiting for the next tab-bar render.
    const active = groups.find((g) => g.isActive);
    this.activeGroupEngine = active?.engine ?? 'claude';
    const addButton = this.tabBar.querySelector<HTMLElement>('.tab-add');
    if (addButton) {
      addButton.dataset.tooltip = this.newTerminalTooltip();
    }

    // A rename in progress has to survive this rebuild. `groupsUpdate` fires for things that have
    // nothing to do with the tab being renamed — another group's terminal starting to wait for
    // input, say — and the field would otherwise vanish mid-word. Restored after appending, since
    // an element outside the document cannot take focus.
    if (this.renamingGroupId !== null) {
      const group = groups.find((g) => g.id === this.renamingGroupId);
      const element = this.groupBar.querySelector<HTMLDivElement>(
        `.group-tab[data-id="${CSS.escape(this.renamingGroupId)}"]`
      );
      if (group && element) {
        this.startGroupRename(element, group);
      } else {
        // The group is gone (closed elsewhere); drop the pending edit rather than keep a draft
        // for something that no longer exists.
        this.renamingGroupId = null;
        this.renameDraft = null;
      }
    }
  }

  /**
   * Turns the group tab's name into a text field. Enter commits, Escape reverts, losing focus
   * commits — the same bargain VS Code's own inline renames make.
   */
  private startGroupRename(element: HTMLDivElement, group: GroupInfo): void {
    const nameElement = element.querySelector<HTMLElement>('.group-tab-name');
    if (!nameElement) {
      return;
    }

    this.renamingGroupId = group.id;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'group-tab-rename';
    input.value = this.renameDraft ?? group.name;
    input.setAttribute('aria-label', `Rename ${group.name}`);
    // The field grows with what is typed, so a long folder name is never cut off mid-rename
    // either. `size` counts characters, which is close enough at this type size.
    const fitToValue = (): void => {
      input.size = Math.max(input.value.length + 1, 6);
    };
    fitToValue();
    nameElement.replaceWith(input);

    let finished = false;
    const finish = (commit: boolean): void => {
      if (finished) {
        return;
      }
      finished = true;
      const value = input.value;
      this.renamingGroupId = null;
      this.renameDraft = null;
      input.replaceWith(nameElement);
      if (commit) {
        // The host refuses an empty or unchanged name and answers with `groupsUpdate` either
        // way, so the bar always ends up showing the name that actually applies.
        this.postMessage({ type: 'renameGroup', id: group.id, name: value });
      }
    };

    input.oninput = (): void => {
      this.renameDraft = input.value;
      fitToValue();
    };
    // Keystrokes must not reach the tab bar or the terminal behind it.
    input.onkeydown = (event): void => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    };
    // `isConnected` separates a real blur from the field being torn out by a redraw. Committing
    // on the latter would post the half-typed draft and cancel the restore above.
    input.onblur = (): void => {
      if (input.isConnected) {
        finish(true);
      }
    };
    input.onclick = (event): void => {
      event.stopPropagation();
    };
    input.ondblclick = (event): void => {
      event.stopPropagation();
    };

    input.focus();
    input.select();
  }

  private createGroupAddButton(): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'group-add';
    button.dataset.tooltip = 'New Terminal Tab';
    button.setAttribute('aria-label', 'New Terminal Tab');
    button.onclick = (): void => {
      this.postMessage({ type: 'newGroup' });
    };
    return button;
  }

  private createGroupElement(group: GroupInfo, closable: boolean): HTMLDivElement {
    const element = document.createElement('div');
    element.className = `group-tab ${group.isActive ? 'active' : ''}`;
    element.dataset.id = group.id;
    // The directory is the point of a group, so it belongs in the tooltip.
    const engineLabel = group.engine === 'opencode' ? 'OpenCode' : 'Claude';
    const count = `${String(group.terminalCount)} terminal${group.terminalCount === 1 ? '' : 's'}`;
    element.dataset.tooltip = `${group.name} — ${engineLabel} — ${count} — ${group.cwd}`;

    // The accent goes on a custom property, not on the element's own colour: the bar is drawn by
    // `.group-tab::after`, so the inactive state can dim the bar alone. Dimming the element would
    // take the name and — worse — the waiting-for-input pill down with it.
    if (group.accentColor) {
      element.style.setProperty('--group-accent', group.accentColor);
    }

    const nameElement = document.createElement('span');
    nameElement.className = 'group-tab-name';
    nameElement.textContent = group.name;
    element.appendChild(nameElement);

    // A pill here stands for a terminal waiting for input in a group that may be off screen —
    // without it that tab has nowhere to announce itself.
    if (group.hasWaitingTerminal) {
      const pill = document.createElement('span');
      pill.className = 'notification-pill';
      element.appendChild(pill);
    }

    // The last group has no close button: the panel is never without one.
    if (closable) {
      const closeButton = document.createElement('button');
      closeButton.className = 'group-tab-close';
      closeButton.dataset.tooltip = 'Close Terminal Tab';
      closeButton.setAttribute('aria-label', `Close ${group.name}`);
      closeButton.onclick = (event): void => {
        event.stopPropagation();
        this.postMessage({ type: 'closeGroup', id: group.id });
      };
      // Two quick clicks on the close button must not also open the rename field.
      closeButton.ondblclick = (event): void => {
        event.stopPropagation();
      };
      element.appendChild(closeButton);
    }

    element.onclick = (): void => {
      if (!group.isActive) {
        this.postMessage({ type: 'switchGroup', id: group.id });
      }
    };

    // Double-click renames. The two clicks underneath have already activated the group, which is
    // what you want anyway — you rename the tab you just moved to.
    element.ondblclick = (): void => {
      if (this.renamingGroupId === null) {
        this.startGroupRename(element, group);
      }
    };

    return element;
  }

  renderTabBar(tabsList: TabInfo[]): void {
    this.tabBar.innerHTML = '';

    tabsList.forEach((tab, index) => {
      const tabElement = this.createTabElement(tab, index);
      this.tabBar.appendChild(tabElement);
    });

    const addButton = this.createAddButton();
    this.tabBar.appendChild(addButton);
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

    // The engine accent goes in as a custom property: the stylesheet dims it for inactive tabs
    // together with the number, while the waiting-for-input pill keeps its full contrast.
    if (tab.accentColor) {
      tabElement.dataset.accent = 'true';
      tabElement.style.setProperty('--tab-accent', tab.accentColor);
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
    // The button no longer asks which CLI to run — it opens the group's. Naming it here is the
    // only place that says so before you click.
    addButton.dataset.tooltip = this.newTerminalTooltip();
    addButton.onclick = () => {
      this.postMessage({ type: 'newTab' });
    };
    return addButton;
  }

  private newTerminalTooltip(): string {
    const label = this.activeGroupEngine === 'opencode' ? 'OpenCode' : 'Claude';
    return `New ${label} Terminal (Cmd+Shift+\`)`;
  }

  createTerminalElement(id: string, name = '', awaitingStart = false): TerminalEntry {
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
    entry.name = name;
    this.state.set(id, entry);

    if (awaitingStart) {
      this.startStartupIndicator(entry, name);
    }

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
   * The "starting…" indicator, shown while a fresh tab waits for its process to print anything.
   *
   * Purely DOM: it never touches the PTY, so it cannot disturb the alternate-screen setup a TUI
   * does on its first frame. Measured on this machine, OpenCode needs 5.1–5.4 s from spawn to its
   * first visible output — until now that was five seconds of blank surface with nothing to say
   * whether anything was happening at all. Claude Code answers in a fraction of that, which is
   * why the indicator waits a quarter second before appearing: a fast start must never flash it.
   */
  private startStartupIndicator(entry: TerminalEntry, name: string): void {
    const startedAt = Date.now();
    // "OpenCode 2" is the tab, "OpenCode" is the program — the number says nothing here.
    const label = name.replace(/\s+\d+$/, '') || 'the terminal';

    entry.startupShowTimer = window.setTimeout(() => {
      entry.startupShowTimer = undefined;

      const indicator = document.createElement('div');
      indicator.className = 'terminal-startup';

      const spinner = document.createElement('span');
      spinner.className = 'terminal-startup-spinner';
      indicator.appendChild(spinner);

      const text = document.createElement('span');
      text.className = 'terminal-startup-label';
      text.textContent = `Starting ${label}…`;
      indicator.appendChild(text);

      const elapsed = document.createElement('span');
      elapsed.className = 'terminal-startup-elapsed';
      indicator.appendChild(elapsed);

      entry.element.appendChild(indicator);
      entry.startupIndicator = indicator;

      // Seconds only from the second one: a counter that starts at "0 s" reads like a stopwatch
      // nobody asked for, while a wait that has visibly passed two seconds is worth quantifying.
      entry.startupTickTimer = window.setInterval(() => {
        const seconds = Math.floor((Date.now() - startedAt) / 1000);
        elapsed.textContent = seconds >= 2 ? `${String(seconds)} s` : '';
      }, 250);
    }, WebviewContext.STARTUP_INDICATOR_DELAY_MS);
  }

  /** Removes the indicator and both its timers, whichever of them are still around. */
  clearStartupIndicator(entry: TerminalEntry): void {
    if (entry.startupShowTimer !== undefined) {
      window.clearTimeout(entry.startupShowTimer);
      entry.startupShowTimer = undefined;
    }
    if (entry.startupTickTimer !== undefined) {
      window.clearInterval(entry.startupTickTimer);
      entry.startupTickTimer = undefined;
    }
    if (entry.startupIndicator) {
      entry.startupIndicator.remove();
      entry.startupIndicator = undefined;
    }
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

  /**
   * Wakes a restored tab whose process was never started.
   *
   * `terminalReady` is sent once per tab, so a tab restored cold has already spent its one report
   * and could never ask for a process. Clearing `readySent` lets it report again, which is what
   * the host waits for before spawning — the size still reaches the CLI before its first frame.
   */
  startRestoredTerminal(id: string): void {
    const entry = this.state.get(id);
    if (!entry) {
      return;
    }
    entry.readySent = false;
    this.startStartupIndicator(entry, entry.name ?? '');
    entry.fitAddon.fit();
    this.scheduleReadyReport(id, entry);
  }

  switchToTerminal(id: string): void {
    const active = this.state.get(id);
    if (!active) {
      // Hiding every wrapper for an id nobody has would blank the panel with no way back but
      // the next switchTab. A stale id — a switch racing a close — costs a warning, nothing else.
      console.warn(`[webview] switchTab to unknown terminal ${id}`);
      return;
    }

    this.state.forEach((t, tid) => {
      t.element.style.display = tid === id ? 'block' : 'none';
      // A tab can still be in its measuring pass, where the wrapper is hidden but laid out.
      // Without this the freshly activated terminal would have `display: block` and stay
      // invisible until the next thing happened to clear it.
      t.element.style.visibility = '';
    });

    this.state.setActiveId(id);
    this.statusLine.setActive(id);

    {
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
      // A tab can be closed while it is still starting; its timers would otherwise keep ticking
      // against an element that is already gone — and a pending ready report would tell the host
      // the size of a terminal it has already torn down.
      this.clearStartupIndicator(t);
      if (t.readyTimer !== undefined) {
        window.clearTimeout(t.readyTimer);
        t.readyTimer = undefined;
      }
      t.terminal.dispose();
      t.element.remove();
      this.state.delete(id);
    } else {
      console.warn(`[webview] removeTab for unknown terminal ${id}`);
    }
    if (this.state.getActiveId() === id) {
      this.state.setActiveId(null);
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
