/**
 * The process monitor's host half (`src/shellWatcher.ts`, Daniel 2026-11-13): Claude's Bash calls
 * from the mod's `shells` list, with the tail of the output file Claude Code writes for each.
 *
 * Bundles the watcher without VS Code and points it at a scratch `claude-<uid>` folder laid out
 * like Claude Code 2.1.323's (`<project>/<session id>/tasks/<task id>.output`, measured). Checks:
 * a background call finds its file by task id and reads it as it grows; a `\r`-redrawn progress
 * line keeps its last state; colour codes stay and cursor moves go; `[exited with code 3]` ends it
 * as failed and leaves the output; a foreground call takes the file born after it started, not an
 * older one; it leaves when the mod drops it; a call without a findable file turns unreadable;
 * dismiss hides a finished call while the mod still lists it. Red before the change: no module.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { check, finish } = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-shells-'));
const bundle = path.join(scratch, 'shells.js');
execFileSync(
  path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
  [
    process.env.PROBE_SHELLS_SRC || path.join(ROOT, 'src', 'shellWatcher.ts'),
    '--bundle',
    '--platform=node',
    '--format=cjs',
    `--outfile=${bundle}`
  ],
  { stdio: 'pipe' }
);
const { ShellWatcher, tailLines } = require(bundle);

const root = path.join(scratch, 'claude-501');
const tasks = path.join(root, '-Users-me-project', 'sess-1', 'tasks');
fs.mkdirSync(tasks, { recursive: true });
const emitted = [];
const watcher = new ShellWatcher((id, shells) => emitted.push([id, shells]), [root]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const live = (shells) => JSON.stringify({ v: 1, updatedAt: Date.now(), shells });
const latest = (key) => {
  for (let i = emitted.length - 1; i >= 0; i--) {
    const run = emitted[i][1].find((s) => s.key === key);
    if (run) return run;
    if (emitted[i][0] === 't1') return undefined;
  }
  return undefined;
};

(async () => {
  // tailLines alone
  check(
    'tail: \\r keeps the last redraw, CSI moves go, SGR stays',
    tailLines('a\r\nprog 10%\rprog 90%\n\x1b[2K\x1b[32mok\x1b[0m\n\n'),
    ['a', 'prog 90%', '\x1b[32mok\x1b[0m']
  );
  check(
    'tail: last 8 lines',
    tailLines(Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n')).length,
    8
  );

  // 1. background call: its file by task id, read as it grows
  const bgFile = path.join(tasks, 'b9bxey20n.output');
  fs.writeFileSync(bgFile, 'out 1\nerr 1\n');
  const bg = {
    key: 'b1',
    command: 'npm run watch',
    startedAt: Date.now(),
    sessionId: 'sess-1',
    background: true,
    taskId: 'b9bxey20n'
  };
  watcher.update('t1', live([bg]));
  let run = latest('b1');
  check('background: running', run && run.state, 'running');
  check('background: lines so far', run && run.lines, ['out 1', 'err 1']);
  fs.appendFileSync(bgFile, 'out 2\n');
  await sleep(700);
  check('background: grows', latest('b1').lines, ['out 1', 'err 1', 'out 2']);
  fs.appendFileSync(bgFile, '\n[exited with code 3]\n');
  await sleep(700);
  run = latest('b1');
  check('background: exit 3 is failed', [run.state, run.exitCode], ['failed', 3]);
  check('background: the mark is not a line', run.lines, ['out 1', 'err 1', 'out 2']);
  check('background: ended at', typeof run.endedAt, 'number');

  // 2. foreground call: an older file is not its own, the one born after its start is
  const old = path.join(tasks, 'old1.output');
  fs.writeFileSync(old, 'stale\n');
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(old, past, past);
  await sleep(1600); // birth time can't be set back; wait past the slack instead
  const fgStart = Date.now();
  const fg = {
    key: 'f1',
    command: 'npm test',
    startedAt: fgStart,
    sessionId: 'sess-1',
    background: false
  };
  watcher.update('t1', live([bg, fg]));
  check('foreground: no file yet, still readable', latest('f1').readable, true);
  fs.writeFileSync(path.join(tasks, 'fg2.output'), 'test 1 ok\n');
  await sleep(700);
  check('foreground: takes the file born after it, not the old one', latest('f1').lines, [
    'test 1 ok'
  ]);
  watcher.update('t1', live([bg]));
  check('foreground: gone once the mod drops it', latest('f1'), undefined);

  // 3. a call whose session folder does not exist turns unreadable after 5 s
  const lost = {
    key: 'x1',
    command: 'make',
    startedAt: Date.now() - 6000,
    sessionId: 'nope',
    background: false
  };
  watcher.update('t1', live([bg, lost]));
  check('missing folder: unreadable', latest('x1').readable, false);

  // 4. dismiss: gone while the mod still lists it
  watcher.dismiss('t1', 'b1');
  watcher.update('t1', live([bg, lost]));
  check('dismissed: not back', latest('b1'), undefined);

  // 5. markup in a command is data
  check('half-written file is ignored', (watcher.update('t1', '{"v":1,"shel'), true), true);

  watcher.dispose();
  fs.rmSync(scratch, { recursive: true, force: true });
  finish('shell watcher');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
