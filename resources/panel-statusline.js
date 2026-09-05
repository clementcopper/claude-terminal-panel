/**
 * Status line producer for Claude Terminal Panel.
 *
 * Claude Code hands the session data — model, token counts, rate limits — only to the
 * configured `statusLine` command, on stdin. The extension host never sees it: from the PTY it
 * gets bytes. So the panel injects this script per session through `claude --settings` and reads
 * back what it writes here.
 *
 * Contract, all through the environment:
 *   CLAUDE_PANEL_STATUS_DIR   directory to write into (required)
 *   CLAUDE_PANEL_TAB_ID       file name without extension (required)
 *   CLAUDE_PANEL_COMPACT_BUDGET   target number of compactions, 0 hides the budget
 *   CLAUDE_PANEL_DELEGATE     the user's own statusLine command, run afterwards for its side
 *                             effects (notifications and such); its output is discarded
 *
 * Prints nothing: inside the panel the webview draws the row, so any text here would show up
 * twice. Never fails loudly either — a broken status line must not disturb the session.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

/**
 * Where the compaction counts are remembered between renders — beside the status directories,
 * not inside one: the extension watches those and reads every `.json` in them as a snapshot.
 */
const COMPACTION_CACHE_DIR = path.join(os.tmpdir(), 'claude-terminal-panel', 'compactions');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** `~` instead of the home directory, the way a shell prompt would show it. */
function collapseHome(dir) {
  const home = os.homedir();
  if (home && dir === home) return '~';
  if (home && dir.startsWith(home + path.sep)) {
    return '~' + dir.slice(home.length);
  }
  return dir;
}

/** Effort level plus fast mode, e.g. `high · fast`. */
function buildEffort(payload) {
  const parts = [];
  const level = payload.effort && payload.effort.level;
  if (typeof level === 'string' && level.length > 0) {
    parts.push(level);
  }
  if (payload.fast_mode === true) {
    parts.push('fast');
  }
  return parts.join(' · ');
}

/** `Fri 8:00 PM` — a fixed point can be planned around, a remaining duration cannot. */
function formatResetTime(epochSeconds) {
  const seconds = num(epochSeconds);
  if (seconds === undefined) return undefined;
  try {
    return new Date(seconds * 1000)
      .toLocaleString('en-US', {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      })
      .replace(',', '');
  } catch {
    return undefined;
  }
}

function minutesUntil(epochSeconds) {
  const seconds = num(epochSeconds);
  if (seconds === undefined) return undefined;
  return Math.max(0, Math.round((seconds * 1000 - Date.now()) / 60000));
}

/**
 * Counts compactions in the transcript. Claude Code writes exactly one structured line per
 * compaction: {"type":"system","subtype":"compact_boundary","compactMetadata":{"trigger":…}}.
 *
 * A plain text search over the file is not enough: the transcript also contains tool results
 * and command lines that merely mention the marker — including this file whenever it is edited.
 * So the cheap `includes` only preselects, and `JSON.parse` decides structurally.
 */
function countCompactions(transcriptPath) {
  const result = { total: 0, auto: 0 };
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) {
    return result;
  }

  // The transcript is append-only and this runs on every render — for a 17 MB session that was
  // half a second of reading and splitting per render, measured. So the count is remembered per
  // transcript together with the byte offset it was taken at, and a render scans only what
  // Claude Code appended since. A file that shrank (a new session under the same path) starts
  // over from zero.
  let size;
  try {
    size = fs.statSync(transcriptPath).size;
  } catch {
    return result;
  }
  const cacheFile = path.join(
    COMPACTION_CACHE_DIR,
    `${crypto.createHash('sha1').update(transcriptPath).digest('hex')}.json`
  );
  let offset = 0;
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (
      cached &&
      Number.isInteger(cached.offset) &&
      cached.offset <= size &&
      Number.isInteger(cached.total) &&
      Number.isInteger(cached.auto)
    ) {
      offset = cached.offset;
      result.total = cached.total;
      result.auto = cached.auto;
    }
  } catch {
    // no cache yet, or an unreadable one — a full scan then
  }
  if (size === offset) {
    return result;
  }

  let chunk;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      chunk = Buffer.alloc(size - offset);
      const read = fs.readSync(fd, chunk, 0, chunk.length, offset);
      chunk = chunk.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return result;
  }

  // Only complete lines count, and the offset advances only past them: Claude Code may be in
  // the middle of writing the last one.
  const lastNewline = chunk.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    return result;
  }
  const complete = chunk.subarray(0, lastNewline + 1);
  for (const line of complete.toString('utf8').split('\n')) {
    if (!line.includes('compact_boundary')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry && entry.type === 'system' && entry.subtype === 'compact_boundary') {
      result.total += 1;
      if (entry.compactMetadata && entry.compactMetadata.trigger === 'auto') {
        result.auto += 1;
      }
    }
  }

  try {
    fs.mkdirSync(COMPACTION_CACHE_DIR, { recursive: true, mode: 0o700 });
    const temp = `${cacheFile}.${String(process.pid)}.tmp`;
    fs.writeFileSync(
      temp,
      JSON.stringify({ offset: offset + complete.length, total: result.total, auto: result.auto }),
      { mode: 0o600 }
    );
    fs.renameSync(temp, cacheFile);
  } catch {
    // Not remembered this time; the next render scans again. Never worth failing the row over.
  }

  return result;
}

function buildSnapshot(payload) {
  const contextWindow = payload.context_window || {};
  const totalTokens = num(contextWindow.context_window_size) ?? 0;
  const usedTokens = num(contextWindow.total_input_tokens) ?? 0;

  // Computed rather than taken from used_percentage: that field is rounded to whole percent,
  // so on a 1M window it moves in 10,000-token steps and disagrees with the count beside it.
  const usedPercent =
    totalTokens > 0 ? (usedTokens / totalTokens) * 100 : (num(contextWindow.used_percentage) ?? 0);

  const rateLimits = payload.rate_limits || {};
  const fiveHour = rateLimits.five_hour || {};
  const sevenDay = rateLimits.seven_day || {};

  const workspace = payload.workspace || {};
  const rawCwd =
    typeof payload.cwd === 'string' && payload.cwd.length > 0
      ? payload.cwd
      : typeof workspace.current_dir === 'string'
        ? workspace.current_dir
        : '';

  const compactions = countCompactions(payload.transcript_path);
  const budget = Number.parseInt(process.env.CLAUDE_PANEL_COMPACT_BUDGET || '0', 10);
  const effort = buildEffort(payload);

  return {
    model: (payload.model && payload.model.display_name) || '',
    effort: effort.length > 0 ? effort : null,
    cwd: rawCwd.length > 0 ? collapseHome(rawCwd) : null,
    usedTokens,
    totalTokens,
    usedPercent: Math.round(usedPercent * 10) / 10,
    sessionPercent: num(fiveHour.used_percentage) ?? null,
    // Both: the absolute point survives being remembered across sessions, the minutes stay for
    // any reader that does not know the newer field.
    sessionResetsAt: num(fiveHour.resets_at) ?? null,
    sessionResetsInMin: minutesUntil(fiveHour.resets_at) ?? null,
    weekPercent: num(sevenDay.used_percentage) ?? null,
    weekResetsAt: formatResetTime(sevenDay.resets_at) ?? null,
    compacted: compactions.total,
    compactBudget: Number.isFinite(budget) && budget > 0 ? budget : null,
    compactAuto: compactions.auto,
    updatedAt: Math.floor(Date.now() / 1000)
  };
}

/** Atomic: the watcher must never read a half-written file. */
function writeSnapshot(dir, tabId, snapshot) {
  // The id names a file inside `dir`; the extension mints it as `terminal-<ts>-<rand>`, but the
  // env contract is public, so a value with a separator in it must not reach path.join.
  if (!/^[\w.-]+$/.test(tabId)) return;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, `${tabId}.json`);
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(snapshot), { mode: 0o600 });
  fs.renameSync(temp, target);
}

/**
 * Runs the user's own statusLine command so its side effects still happen. The panel variables
 * are stripped from its environment, so a panel-aware script behaves like it would in any other
 * terminal instead of writing the same file again.
 */
function runDelegate(command, input) {
  const env = { ...process.env };
  delete env.CLAUDE_PANEL_STATUS_DIR;
  delete env.CLAUDE_PANEL_TAB_ID;
  delete env.CLAUDE_PANEL_COMPACT_BUDGET;
  delete env.CLAUDE_PANEL_DELEGATE;

  try {
    execSync(command, { input, env, stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000 });
  } catch {
    // The delegate is a courtesy; its failure is not ours to report
  }
}

function main() {
  const dir = process.env.CLAUDE_PANEL_STATUS_DIR;
  const tabId = process.env.CLAUDE_PANEL_TAB_ID;
  const raw = readStdin();

  if (!dir || !tabId || raw.length === 0) {
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  try {
    writeSnapshot(dir, tabId, buildSnapshot(payload));
  } catch {
    // Unwritable directory, race with a closing tab — the row simply stays as it was
  }

  const delegate = process.env.CLAUDE_PANEL_DELEGATE;
  if (delegate) {
    runDelegate(delegate, raw);
  }
}

main();
