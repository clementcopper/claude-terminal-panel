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
const { execSync } = require('child_process');

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

  let content;
  try {
    content = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return result;
  }

  for (const line of content.split('\n')) {
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

  return result;
}

function buildSnapshot(payload) {
  const contextWindow = payload.context_window || {};
  const totalTokens = num(contextWindow.context_window_size) ?? 0;
  const usedTokens = num(contextWindow.total_input_tokens) ?? 0;

  // Computed rather than taken from used_percentage: that field is rounded to whole percent,
  // so on a 1M window it moves in 10,000-token steps and disagrees with the count beside it.
  const usedPercent =
    totalTokens > 0
      ? (usedTokens / totalTokens) * 100
      : (num(contextWindow.used_percentage) ?? 0);

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
