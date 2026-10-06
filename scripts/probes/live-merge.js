/**
 * The watcher merges the mod's `<tab>.live.json` over the producer's `<tab>.json`.
 *
 * Bundles src/statusLineWatcher.ts without VS Code (it imports none), points TMPDIR at a scratch
 * directory and drives `read()` directly — fs.watch timing is not what is under test. Checks the
 * suffix mapping (a live file must not become a tab called `<id>.live`), fresher-wins for the
 * token fields, the live-only fields, the compaction rule after a /clear, the formatted week
 * reset, a truncated live file leaving the previous one standing, removeLive stripping the live
 * fields, and that the remembered per-cwd snapshot carries no live field. Red on the watcher
 * before the live bridge: it had no `.live.json` handling at all.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { check, finish } = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-live-merge-'));
process.env.TMPDIR = scratch;

const bundle = path.join(scratch, 'watcher.js');
execFileSync(
  path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
  [
    path.join(ROOT, 'src', 'statusLineWatcher.ts'),
    '--bundle',
    '--platform=node',
    '--format=cjs',
    `--outfile=${bundle}`
  ],
  { stdio: 'pipe' }
);
const { StatusLineWatcher, getStatusLineDir } = require(bundle);

const emitted = [];
const watcher = new StatusLineWatcher((id, snapshot) => emitted.push([id, snapshot]), 10);
const dir = getStatusLineDir();
fs.mkdirSync(dir, { recursive: true });
const last = () => emitted[emitted.length - 1][1];
const write = (name, payload) =>
  fs.writeFileSync(
    path.join(dir, name),
    typeof payload === 'string' ? payload : JSON.stringify(payload)
  );

// Suffix mapping: the debounce key of a live write is the tab id
watcher.scheduleRead('t1.live.json');
check('live file schedules the tab, not <id>.live', [...watcher.debounceTimers.keys()], ['t1']);
watcher.clearTimer('t1');

const producer = {
  model: 'Fable 5.1',
  cwd: '~/p',
  usedTokens: 100,
  totalTokens: 1000,
  usedPercent: 10,
  compacted: 2,
  compactAuto: 1,
  weekPercent: 40,
  weekResetsAt: 'Fri 8:00 PM',
  updatedAt: 1000
};
write('t1.json', producer);
watcher.read('t1');
check('producer only: tokens from producer', [last().usedTokens, last().state], [100, undefined]);

// Fresher live wins the tokens and brings its own fields
const live = {
  v: 1,
  updatedAt: 1_500_000,
  resetAt: 0,
  usedTokens: 250,
  totalTokens: 1000,
  usedPercent: 25,
  stepIndex: 3,
  state: 'busy',
  stateAt: 1_400_000,
  tool: { name: 'Bash', summary: 'npm run compile' },
  agents: 2,
  compacted: 1,
  compactAuto: 0,
  weekPercent: 41,
  weekResetsEpoch: 1_791_760_000,
  costUsd: 1.27
};
write('t1.live.json', live);
watcher.read('t1');
check(
  'fresher live: tokens, state, tool, agents, cost',
  [
    last().usedTokens,
    last().stepIndex,
    last().state,
    last().tool.name,
    last().agents,
    last().costUsd
  ],
  [250, 3, 'busy', 'Bash', 2, 1.27]
);
check('compaction: max of both while no /clear', [last().compacted, last().compactAuto], [2, 1]);
check('week reset formatted from the epoch', typeof last().weekResetsAt, 'string');
check('model stays the display name', last().model, 'Fable 5.1');
check('updatedAt is the fresher, in seconds', last().updatedAt, 1500);

// Producer fresher than live: its tokens, but the live state still rides along
write('t1.json', { ...producer, usedTokens: 300, usedPercent: 30, updatedAt: 2000 });
watcher.read('t1');
check(
  'fresher producer: tokens from producer, state from live',
  [last().usedTokens, last().liveAt, last().state],
  [300, undefined, 'busy']
);

// After a /clear the mod's zero beats the producer's stale count
write('t1.live.json', {
  ...live,
  updatedAt: 2_500_000,
  resetAt: 2_400_000,
  compacted: 0,
  compactAuto: 0
});
watcher.read('t1');
check('compaction after /clear: live count wins', [last().compacted, last().compactAuto], [0, 0]);

// A truncated live file leaves the previous one standing
write('t1.live.json', '{"v":1,"updatedAt":2600000,"usedTok');
watcher.read('t1');
check('truncated live file: previous live stands', [last().compacted, last().state], [0, 'busy']);

// The remembered per-cwd snapshot carries no live field
const remembered = JSON.parse(
  fs.readFileSync(
    fs
      .readdirSync(path.join(scratch, 'claude-terminal-panel', 'status', 'last'))
      .map((n) => path.join(scratch, 'claude-terminal-panel', 'status', 'last', n))
      .find((f) => !f.endsWith('limits.json')),
    'utf8'
  )
);
check(
  'remembered snapshot has no live fields',
  ['state', 'tool', 'costUsd'].filter((k) => k in remembered),
  []
);

// removeLive strips the live fields and re-emits; the token figure stays the fresher one it had
watcher.removeLive('t1');
check(
  'removeLive: file gone, state gone, last tokens kept',
  [fs.existsSync(path.join(dir, 't1.live.json')), last().state, last().usedTokens],
  [false, undefined, 250]
);

// Live only (before the producer's first run): cwd and state from the mod
write('t2.live.json', {
  v: 1,
  updatedAt: 3_000_000,
  resetAt: 0,
  cwd: path.join(os.homedir(), 'q'),
  state: 'idle',
  stateAt: 3_000_000
});
watcher.read('t2');
check(
  'live only: cwd collapsed, state present, no ring',
  [last().cwd, last().state, last().totalTokens],
  ['~/q', 'idle', 0]
);

watcher.dispose();
fs.rmSync(scratch, { recursive: true, force: true });
finish('live merge');
