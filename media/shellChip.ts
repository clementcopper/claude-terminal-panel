import { formatDuration } from './progressChip';
import type { ShellRun } from './types';

/**
 * The process monitor (Daniel, 2026-11-13, `Sessions/Fortschritt-Auftrag.md`): a Bash call of
 * Claude's as a chip in the progress chip's form. Folded: mark, command, run time. Open: the last
 * lines of its output, read-only. A call that writes a progress list shows its output inside that
 * list's chip instead (`buildShellOutput`).
 *
 * The output is model- and program-generated: every line is set as text, colour codes become
 * classes, nothing is parsed as markup.
 */

/** The output box always holds this many lines, so a growing tail never moves the terminal. */
export const OUTPUT_ROWS = 8;

const ANSI_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

function span(className: string, text?: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function drawn(className: string, d: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  if (className) svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 8 8');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  svg.appendChild(path);
  return svg;
}

/** One output line with its SGR colour codes turned into spans; anything else is text. */
export function ansiLine(line: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'shell-line';
  let fg: string | undefined;
  let bold = false;
  let dim = false;
  // eslint-disable-next-line no-control-regex
  const parts = line.split(/\x1b\[([0-9;]*)m/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const codes = parts[i] === '' ? [0] : parts[i]!.split(';').map(Number);
      for (let c = 0; c < codes.length; c++) {
        const code = codes[c]!;
        if (code === 0) {
          fg = undefined;
          bold = false;
          dim = false;
        } else if (code === 1) bold = true;
        else if (code === 2) dim = true;
        else if (code === 22) {
          bold = false;
          dim = false;
        } else if (code === 39) fg = undefined;
        else if (code >= 30 && code <= 37) fg = ANSI_NAMES[code - 30];
        else if (code >= 90 && code <= 97) fg = `bright-${ANSI_NAMES[code - 90]!}`;
        else if (code === 38 || code === 48) {
          // 256-colour and truecolour: skip their arguments, keep the default colour
          c += codes[c + 1] === 5 ? 2 : codes[c + 1] === 2 ? 4 : 0;
        }
      }
      continue;
    }
    const text = parts[i]!;
    if (!text) continue;
    const classes = [fg ? `ansi-${fg}` : '', bold ? 'ansi-bold' : '', dim ? 'ansi-dim' : '']
      .filter(Boolean)
      .join(' ');
    row.appendChild(classes ? span(classes, text) : document.createTextNode(text));
  }
  return row;
}

/** The read-only output box: the last lines, a block cursor while the call runs. */
export function buildShellOutput(lines: string[], running: boolean, readable = true): HTMLElement {
  const box = document.createElement('div');
  box.className = 'shell-out';
  if (!readable) {
    box.appendChild(span('shell-note', 'Output not readable'));
    box.dataset.tooltip = "Claude Code's output file for this call was not found";
    return box;
  }
  const shown = lines.slice(-(running ? OUTPUT_ROWS - 1 : OUTPUT_ROWS));
  for (const line of shown) box.appendChild(ansiLine(line));
  if (running) {
    const last = document.createElement('div');
    last.className = 'shell-line';
    last.appendChild(span('shell-cursor'));
    box.appendChild(last);
  }
  return box;
}

function headTime(run: ShellRun, now: number): string {
  return formatDuration((run.endedAt ?? now) - run.startedAt);
}

function mark(run: ShellRun): HTMLElement {
  if (run.state === 'running') return span('terminal-startup-spinner status-spinner progress-mark');
  return span(`progress-mark ${run.state}`, run.state === 'done' ? '✓' : '✕');
}

export function buildShellChip(
  run: ShellRun,
  expanded: boolean,
  onToggle: (key: string) => void,
  onDismiss: (key: string) => void
): HTMLElement {
  const now = Date.now();
  const chip = document.createElement('div');
  chip.className = `progress-chip shell-chip ${run.state}${expanded ? '' : ' collapsed'}`;
  chip.dataset.shellKey = run.key;

  const head = document.createElement('div');
  head.className = 'progress-head';
  const toggle = document.createElement('button');
  toggle.className = 'progress-toggle';
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.dataset.tooltip = [run.description, run.command].filter(Boolean).join('\n');
  toggle.append(mark(run), span('progress-title shell-command', run.command || 'Bash'));
  if (run.state === 'failed' && run.exitCode !== undefined) {
    toggle.appendChild(span('progress-fail-count', `exit ${String(run.exitCode)}`));
  }
  toggle.append(
    span('progress-time', headTime(run, now)),
    drawn('progress-chevron', expanded ? 'M1 5L4 2L7 5' : 'M1 3L4 6L7 3')
  );
  toggle.addEventListener('click', () => onToggle(run.key));
  head.appendChild(toggle);
  if (run.state !== 'running') {
    const close = document.createElement('button');
    close.className = 'progress-close';
    close.type = 'button';
    close.appendChild(drawn('', 'M1 1L7 7M7 1L1 7'));
    close.setAttribute('aria-label', `Dismiss ${run.command}`);
    close.dataset.tooltip = 'Dismiss';
    close.addEventListener('click', () => onDismiss(run.key));
    head.appendChild(close);
  }
  chip.appendChild(head);
  if (expanded)
    chip.appendChild(buildShellOutput(run.lines, run.state === 'running', run.readable));
  return chip;
}

/** Rewrites the run time only: no height change, no refit. */
export function tickShellChip(chip: HTMLElement, run: ShellRun): void {
  const time = chip.querySelector('.progress-time');
  if (time) time.textContent = headTime(run, Date.now());
}

/** How long before its list a call may have started and still count as the list's writer. */
const LINK_BEFORE_MS = 60_000;

/**
 * The call that feeds a progress list: started up to a minute before the list (a long-running
 * `npm run watch` from an hour ago is not its writer), at the latest 2 s after it, and running or
 * ended after the list began. The newest such call wins.
 */
export function linkedShell(
  shells: readonly ShellRun[],
  listStartedAt: number
): ShellRun | undefined {
  let best: ShellRun | undefined;
  for (const run of shells) {
    if (run.startedAt > listStartedAt + 2000 || run.startedAt < listStartedAt - LINK_BEFORE_MS) {
      continue;
    }
    if (run.state !== 'running' && (run.endedAt ?? 0) < listStartedAt) continue;
    if (!best || run.startedAt > best.startedAt) best = run;
  }
  return best;
}
