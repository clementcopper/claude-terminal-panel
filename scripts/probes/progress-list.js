/**
 * The progress watcher reads the lists programs in a tab write (`README.local.md` § Progress lists).
 *
 * Bundles src/progressWatcher.ts without VS Code, points it at a scratch folder and goes through
 * the real `fs.watch` — the recursive watch on a tab folder the writer creates itself is the part
 * most likely to break. Checks: an atomic write arrives; a half-written file leaves the previous
 * list standing; items are capped at 200 and labels at 120 characters; a file whose `id` disagrees
 * with its name is ignored; a running list with a dead pid reads as cancelled, with a live one as
 * running; dismiss hides the run and keeps the file; closing the tab removes its folder. Red before the watcher
 * existed: the module was missing.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { check, finish } = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-progress-'));
process.env.TMPDIR = scratch;

const bundle = path.join(scratch, 'progress.js');
execFileSync(
  path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
  [
    process.env.PROBE_PROGRESS_SRC || path.join(ROOT, 'src', 'progressWatcher.ts'),
    '--bundle',
    '--platform=node',
    '--format=cjs',
    `--outfile=${bundle}`
  ],
  { stdio: 'pipe' }
);
const { ProgressWatcher } = require(bundle);

const root = path.join(scratch, 'progress');
const emitted = [];
const watcher = new ProgressWatcher((id, lists) => emitted.push([id, lists]), root);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The writer's side of the contract: own folder, temp file not ending in .json, rename. */
function write(tab, id, body, raw) {
  const dir = path.join(root, tab);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${id}.tmp-${String(process.pid)}`);
  fs.writeFileSync(tmp, raw ?? JSON.stringify(body), { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, `${id}.json`));
}

const list = (extra) => ({
  v: 1,
  id: 'kuza-check',
  title: 'kuza check',
  state: 'running',
  pid: process.pid,
  startedAt: Date.now() - 60_000,
  updatedAt: Date.now(),
  items: [
    { id: 'test', label: 'test', state: 'ok', seconds: 71 },
    { id: 'window', label: 'window', state: 'running', startedAt: Date.now() - 5_000 },
    { id: 'height', label: 'height', state: 'pending' }
  ],
  ...extra
});
const lastFor = (tab) => {
  const hits = emitted.filter(([id]) => id === tab);
  return hits.length ? hits[hits.length - 1][1] : undefined;
};

(async () => {
  write('t1', 'kuza-check', list());
  await sleep(400);
  const first = lastFor('t1');
  check('atomic write arrives through the recursive watch', first ? first.length : 0, 1);
  check('items arrive', first && first[0].items.map((i) => i.state), ['ok', 'running', 'pending']);
  check('own pid: running', first && first[0].state, 'running');

  const before = emitted.length;
  fs.writeFileSync(path.join(root, 't1', 'kuza-check.json'), '{"v":1,"id":"kuza-ch');
  await sleep(300);
  check('half-written file: nothing sent', emitted.length, before);
  check('half-written file: the old list stands', watcher.get('t1').length, 1);

  const many = Array.from({ length: 250 }, (_, i) => ({
    id: `r${String(i)}`,
    label: i === 0 ? 'x'.repeat(300) : `run ${String(i)}`,
    state: 'pending'
  }));
  write('t1', 'kuza-check', list({ items: many }));
  await sleep(300);
  const capped = watcher.get('t1')[0];
  check('items capped at 200', capped.items.length, 200);
  check('label cut at 120', capped.items[0].label.length, 120);

  write('t1', 'other', list({ id: 'not-other' }));
  await sleep(300);
  check('id must match the file name', watcher.get('t1').length, 1);

  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  const deadPid = Number(dead.stdout.toString());
  write('t2', 'build', list({ id: 'build', title: 'build', pid: deadPid }));
  await sleep(300);
  check('dead pid: cancelled', watcher.get('t2')[0].state, 'cancelled');

  write('t2', 'done', list({ id: 'done', title: 'done', state: 'done', pid: deadPid }));
  await sleep(300);
  check(
    'finished list keeps its state whatever the pid',
    watcher.get('t2').map((l) => l.state),
    ['cancelled', 'done']
  );

  const doneStartedAt = watcher.get('t2').find((l) => l.id === 'done').startedAt;
  watcher.dismiss('t2', 'done');
  // The × hides the chip; the file lives until the tab closes, so `kuza status` still finds it
  check('dismiss keeps the file', fs.existsSync(path.join(root, 't2', 'done.json')), true);
  check(
    'dismiss sends the rest',
    lastFor('t2').map((l) => l.id),
    ['build']
  );
  check(
    'dismissed list stays hidden for a rebuilt webview',
    watcher.get('t2').map((l) => l.id),
    ['build']
  );
  write(
    't2',
    'done',
    list({ id: 'done', title: 'done', state: 'done', pid: deadPid, startedAt: doneStartedAt })
  );
  await sleep(300);
  check(
    'the same run rewritten stays hidden',
    watcher.get('t2').map((l) => l.id),
    ['build']
  );
  write(
    't2',
    'done',
    list({
      id: 'done',
      title: 'done',
      state: 'running',
      pid: process.pid,
      startedAt: Date.now() + 1000
    })
  );
  await sleep(300);
  check(
    'a new run with the same id shows again',
    watcher.get('t2').map((l) => l.id),
    ['build', 'done']
  );

  watcher.removeTerminal('t1');
  check('closing the tab removes its folder', fs.existsSync(path.join(root, 't1')), false);
  check('closing the tab forgets its lists', watcher.get('t1').length, 0);

  watcher.dispose();
  fs.rmSync(scratch, { recursive: true, force: true });
  finish('progress-list');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
