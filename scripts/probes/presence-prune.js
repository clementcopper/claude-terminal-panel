/**
 * Presence entries expire, and registering a tab prunes the dead ones.
 *
 * Bundles the router with `vscode` aliased away (the probes rule), points the tmp dir at a
 * scratch directory, seeds presence.json with a ten-minute-old entry beside a fresh one, and
 * registers a third. Red on every build before 098b781, which kept all three.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { check, finish } = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-presence-'));
const bundle = path.join(scratch, 'router.js');

execFileSync(
  'npx',
  [
    'esbuild',
    'src/interagent/InterAgentRouter.ts',
    '--bundle',
    '--platform=node',
    '--format=cjs',
    `--alias:vscode=${path.join(__dirname, 'vscode-stub.js')}`,
    '--external:node-pty',
    `--outfile=${bundle}`,
    '--log-level=warning'
  ],
  { cwd: ROOT, stdio: 'inherit' }
);

// `os.tmpdir()` is read when the router computes its directory, so the override has to be in
// place before the bundle loads.
process.env.TMPDIR = scratch;
const { InterAgentRouter } = require(bundle);
const dir = path.join(os.tmpdir(), 'claude-terminal-panel', 'interagent');
fs.mkdirSync(dir, { recursive: true });
const entry = { engine: 'claude', cwd: '/x', cols: 80, rows: 24 };
fs.writeFileSync(
  path.join(dir, 'presence.json'),
  JSON.stringify({
    dead: { ...entry, ts: Date.now() - 10 * 60 * 1000 },
    fresh: { ...entry, ts: Date.now() }
  })
);

const router = new InterAgentRouter({ isLocalTab: () => true, deliver: () => {} });
router.registerPresence('mine', { ...entry, ts: 0 });
const after = JSON.parse(fs.readFileSync(path.join(dir, 'presence.json'), 'utf8'));
check('entries after register', Object.keys(after).sort(), ['fresh', 'mine']);
check('registered entry is stamped now', Date.now() - after.mine.ts < 5000, true);
router.dispose();

fs.rmSync(scratch, { recursive: true, force: true });
finish('presence-prune');
