/**
 * The status line producer counts compactions incrementally and correctly.
 *
 * Runs resources/panel-statusline.js against a synthetic transcript: a boundary line and a text
 * line that merely mentions the marker; then an appended manual boundary; then half a line
 * (must count neither now nor twice later); then the rest of it; then a truncated file, which
 * is a new session. Red on the pre-cache producer for the half-line case only by luck — the
 * point of keeping it is the cache path, which the old producer did not have.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { check, finish } = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-statusline-'));
const transcript = path.join(scratch, 'transcript.jsonl');
const statusDir = path.join(scratch, 'status');
const producer = path.join(ROOT, 'resources', 'panel-statusline.js');

function render() {
  const payload = JSON.stringify({
    transcript_path: transcript,
    cwd: '/tmp',
    model: { display_name: 'Probe' },
    context_window: { context_window_size: 100, total_input_tokens: 1 }
  });
  execFileSync(process.execPath, [producer], {
    input: payload,
    env: {
      ...process.env,
      TMPDIR: scratch,
      CLAUDE_PANEL_STATUS_DIR: statusDir,
      CLAUDE_PANEL_TAB_ID: 'probe'
    }
  });
  const snapshot = JSON.parse(fs.readFileSync(path.join(statusDir, 'probe.json'), 'utf8'));
  return [snapshot.compacted, snapshot.compactAuto];
}

const boundary = (trigger) =>
  JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger } });

fs.writeFileSync(
  transcript,
  `${boundary('auto')}\n{"type":"user","text":"mentions compact_boundary"}\n`
);
check('one auto boundary, one mention', render(), [1, 1]);
fs.appendFileSync(transcript, `${boundary('manual')}\n`);
check('appended manual boundary', render(), [2, 1]);
fs.appendFileSync(transcript, boundary('auto'));
check('half a line is not counted yet', render(), [2, 1]);
fs.appendFileSync(transcript, '\n');
check('completed line counts once', render(), [3, 2]);
fs.writeFileSync(transcript, '{"type":"user"}\n');
check('truncated transcript starts over', render(), [0, 0]);
const cacheDir = path.join(scratch, 'claude-terminal-panel', 'compactions');
check('cache lives beside the status dirs, not inside', fs.existsSync(cacheDir), true);

fs.rmSync(scratch, { recursive: true, force: true });
finish('statusline-cache');
