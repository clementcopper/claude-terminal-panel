import type { ProgressItem, ProgressList } from './types';

/**
 * One progress list as a chip under the prompt chip — layout A, chosen by Daniel on 2026-11-12
 * (`Sessions/Fortschritt-Auftrag.md`). Head: mark, title, count, time. Strip: one cell per item.
 * Foot: what runs or waits now on the left, what failed on the right.
 *
 * Everything that comes from the list is set as text. Paths (`log`, `detail`) only reach the
 * tooltip; nothing here opens them.
 */

/** `42 s`, `1:12`, `1:02:05` — same form as the status line's run time. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${String(total)} s`;
  const s = String(total % 60).padStart(2, '0');
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${String(h)}:${String(m).padStart(2, '0')}:${s}` : `${String(m)}:${s}`;
}

const FINISHED_ITEM = new Set<ProgressItem['state']>(['ok', 'failed', 'blocked', 'info']);

function span(className: string, text?: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function headTime(list: ProgressList, now: number): string {
  const ran = list.updatedAt - list.startedAt;
  switch (list.state) {
    case 'done':
      return `done in ${formatDuration(ran)}`;
    case 'failed':
      return `failed after ${formatDuration(ran)}`;
    case 'cancelled':
      return `cancelled after ${formatDuration(ran)}`;
    default: {
      const elapsed = now - list.startedAt;
      const left =
        list.expectedSeconds !== undefined ? list.expectedSeconds * 1000 - elapsed : undefined;
      // Past the expected time a countdown would only lie; the run time alone stays true
      return left !== undefined && left > 30_000
        ? `${formatDuration(elapsed)} · ~${String(Math.ceil(left / 60_000))} min left`
        : formatDuration(elapsed);
    }
  }
}

function footLeft(list: ProgressList, now: number): string {
  const running = list.items.find((item) => item.state === 'running');
  const next = list.items.find((item) => item.state === 'pending');
  if (list.state === 'cancelled') {
    const at = running ?? next;
    return at ? `cancelled at ${at.label}` : 'cancelled';
  }
  if (list.state !== 'running') {
    const passed = list.items.filter((item) => item.state === 'ok').length;
    return `${String(passed)} passed`;
  }
  if (list.paused) {
    const parts = [`Paused ${formatDuration(now - list.paused.since)}`];
    if (list.paused.reason) parts.push(list.paused.reason);
    if (next) parts.push(`next: ${next.label}`);
    return parts.join(' · ');
  }
  if (!running) return '';
  return running.startedAt !== undefined
    ? `${running.label} ${formatDuration(now - running.startedAt)}`
    : running.label;
}

function mark(list: ProgressList): HTMLElement {
  if (list.state === 'running' && !list.paused) {
    return span('terminal-startup-spinner status-spinner progress-mark');
  }
  const glyph =
    list.state === 'running'
      ? '❚❚'
      : list.state === 'done'
        ? '✓'
        : list.state === 'failed'
          ? '✕'
          : '■';
  return span(
    `progress-mark ${list.paused && list.state === 'running' ? 'paused' : list.state}`,
    glyph
  );
}

/** An 8px stroke icon, the × and the fold arrow; both sit on the head line the same way. */
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

export function buildProgressChip(
  list: ProgressList,
  onDismiss: (listId: string) => void,
  expanded = false,
  onToggle: (listId: string) => void = () => undefined
): HTMLElement {
  const now = Date.now();
  const chip = document.createElement('div');
  chip.className = `progress-chip ${list.state}${expanded ? '' : ' collapsed'}`;
  chip.dataset.listId = list.id;

  const finished = list.items.filter((item) => FINISHED_ITEM.has(item.state)).length;
  const head = document.createElement('div');
  head.className = 'progress-head';
  // The head line is the button that opens and folds the chip (Daniel, 2026-11-12): folded by
  // default, one line; the × beside it is its own button, never nested inside this one.
  const toggle = document.createElement('button');
  toggle.className = 'progress-toggle';
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.dataset.tooltip = expanded ? 'Fold' : 'Show progress';
  toggle.append(
    mark(list),
    span('progress-title', list.title),
    span('progress-count', `${String(finished)} / ${String(list.items.length)}`),
    span('progress-time', headTime(list, now)),
    drawn('progress-chevron', expanded ? 'M1 5L4 2L7 5' : 'M1 3L4 6L7 3')
  );
  // Folded, the foot with its failures is gone; a red count in the head keeps them in sight
  // (Daniel, 2026-11-12). Open, the foot names them and this would say it twice.
  const failedCount = list.items.filter((item) => item.state === 'failed').length;
  if (!expanded && failedCount > 0) {
    toggle.insertBefore(
      span('progress-fail-count', `${String(failedCount)} failed`),
      toggle.querySelector('.progress-time')
    );
  }
  toggle.addEventListener('click', () => onToggle(list.id));
  head.appendChild(toggle);
  if (list.state !== 'running') {
    const close = document.createElement('button');
    close.className = 'progress-close';
    close.type = 'button';
    // Drawn, not the × character: a glyph hangs on the baseline and sat 1.5 px below the title
    close.appendChild(drawn('', 'M1 1L7 7M7 1L1 7'));
    close.setAttribute('aria-label', `Dismiss ${list.title}`);
    close.dataset.tooltip = 'Dismiss';
    close.addEventListener('click', () => onDismiss(list.id));
    head.appendChild(close);
  }

  const strip = document.createElement('div');
  strip.className = 'progress-strip';
  for (const item of list.items) {
    // Once the list has ended nothing runs any more; an item caught mid-run reads as open
    const state = item.state === 'running' && list.state !== 'running' ? 'pending' : item.state;
    const cell = span(`progress-cell ${state}`);
    cell.dataset.tooltip = item.note ? `${item.label}\n${item.note}` : item.label;
    strip.appendChild(cell);
  }

  const foot = document.createElement('div');
  foot.className = 'progress-foot';
  foot.appendChild(span('progress-now', footLeft(list, now)));
  const failed = list.items.filter((item) => item.state === 'failed');
  const blocked = list.items.filter((item) => item.state === 'blocked');
  const bad: string[] = [];
  if (failed.length > 0) {
    bad.push(`${String(failed.length)} failed: ${failed.map((item) => item.label).join(', ')}`);
  }
  if (blocked.length > 0) bad.push(`${String(blocked.length)} blocked`);
  if (bad.length > 0) {
    const right = span('progress-bad', bad.join(' · '));
    right.dataset.tooltip = [...failed, ...blocked]
      .map((item) => [item.label, item.note, item.log].filter((line) => line).join('\n'))
      .join('\n\n');
    foot.appendChild(right);
  }

  // Folded, the chip is its head line alone; the strip and the foot wait in the DOM
  strip.hidden = !expanded;
  foot.hidden = !expanded;
  chip.append(head, strip, foot);
  return chip;
}

/** Whether a chip's texts move with the clock; only those need the one-second tick. */
export function progressTicks(list: ProgressList): boolean {
  return list.state === 'running';
}

/** Rewrites the two texts that depend on the clock, nothing else: no height change, no refit. */
export function tickProgressChip(chip: HTMLElement, list: ProgressList): void {
  const now = Date.now();
  const time = chip.querySelector('.progress-time');
  if (time) time.textContent = headTime(list, now);
  const current = chip.querySelector('.progress-now');
  if (current) current.textContent = footLeft(list, now);
}
