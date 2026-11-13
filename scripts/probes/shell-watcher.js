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
 * After a `/clear` (peer report 2026-11-13): the files stay under the id the process started with,
 * a background call finds them through the mod's `sessionIds` or, from an older mod, by task id in
 * any folder; a foreground call takes only its own process's files; `[killed]` ends a call as
 * failed. Red on d57f379: five checks, the killed call kept spinning with `[killed]` as a line.
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
const latest = (key, terminal = 't1') => {
  for (let i = emitted.length - 1; i >= 0; i--) {
    if (emitted[i][0] !== terminal) continue;
    return emitted[i][1].find((s) => s.key === key);
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
    'tail: the whole output, not the last 8 lines',
    tailLines(Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n')).length,
    20
  );
  check(
    'tail: capped at 500 lines, the newest kept',
    tailLines(Array.from({ length: 600 }, (_, i) => `l${i}`).join('\n')).slice(0, 1),
    ['l100']
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

  // 6. after a /clear (2.1.323, measured 2026-11-13): the session has a new id, the files stay
  // under the id the process started with; the mod names both. A third session in the same
  // project folder (another tab) holds a file that is not this tab's.
  const project = path.join(root, '-Users-me-other');
  const startTasks = path.join(project, 'sess-A', 'tasks');
  const otherTasks = path.join(project, 'sess-9', 'tasks');
  fs.mkdirSync(startTasks, { recursive: true });
  fs.mkdirSync(otherTasks, { recursive: true });
  fs.mkdirSync(path.join(project, 'sess-B', 'scratchpad'), { recursive: true });
  const cleared = { sessionId: 'sess-B', sessionIds: ['sess-A', 'sess-B'] };
  fs.writeFileSync(path.join(startTasks, 'bk1.output'), 'one\n');
  fs.writeFileSync(path.join(startTasks, 'bk2.output'), 'two\n');
  // The killed call sits where the old watcher looks too, so its check is about the mark alone
  fs.writeFileSync(path.join(tasks, 'bk3.output'), 'three\n');
  const bk1 = {
    key: 'k1',
    command: 'a',
    startedAt: Date.now(),
    background: true,
    taskId: 'bk1',
    ...cleared
  };
  // A mod from before the fix names only the new id: found by task id across every folder
  const bk2 = {
    key: 'k2',
    command: 'b',
    startedAt: Date.now(),
    background: true,
    taskId: 'bk2',
    sessionId: 'sess-B'
  };
  const bk3 = {
    key: 'k3',
    command: 'c',
    startedAt: Date.now(),
    background: true,
    taskId: 'bk3',
    sessionId: 'sess-1'
  };
  watcher.update('t2', live([bk1, bk2, bk3]));
  check("cleared: background reads the start id's folder", latest('k1', 't2').lines, ['one']);
  check('cleared: old mod, found by task id', latest('k2', 't2').lines, ['two']);
  fs.appendFileSync(path.join(startTasks, 'bk1.output'), '\n[exited with code 0]\n');
  fs.appendFileSync(path.join(tasks, 'bk3.output'), '\n[killed]\n');
  await sleep(700);
  check('cleared: exit 0 ends it', latest('k1', 't2').state, 'done');
  const killed = latest('k3', 't2');
  check(
    'killed: ends as failed without a code, the mark is not a line',
    [killed.state, killed.exitCode, killed.lines, typeof killed.endedAt],
    ['failed', undefined, ['three'], 'number']
  );

  await sleep(1600); // the background files above are now older than the slack
  const fg2Start = Date.now();
  const fg2 = {
    key: 'f2',
    command: 'npm test',
    startedAt: fg2Start,
    background: false,
    ...cleared
  };
  fs.writeFileSync(path.join(otherTasks, 'theirs.output'), 'not mine\n');
  await sleep(50);
  fs.writeFileSync(path.join(startTasks, 'mine.output'), 'mine\n');
  watcher.update('t2', live([bk1, bk2, bk3, fg2]));
  check(
    "cleared: foreground takes its own process's file, not another tab's",
    latest('f2', 't2').lines,
    ['mine']
  );

  watcher.dispose();
  fs.rmSync(scratch, { recursive: true, force: true });
  finish('shell watcher');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
