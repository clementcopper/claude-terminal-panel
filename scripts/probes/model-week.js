/**
 * The week ring shows a model's own weekly window (Fable) only in that model's tabs.
 *
 * Bundles `statusLineWatcher.ts` and `usageLimits.ts` with the vscode stub, points `TMPDIR` at a
 * scratch directory so the real status area is never touched, then feeds the watcher snapshot
 * files the way the producer writes them. The account-wide week (55 %) must stay in
 * `limits.json` and in every other model's tab; only a Fable tab shows Fable's 100 %. Red on the
 * build before this change: it had no per-model week at all.
 *
 * Optional argument: a directory holding other versions of the two sources (e.g. from
 * `git show HEAD:`), to see the probe red.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { check, finish } = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'src');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-model-week-'));
process.env.TMPDIR = scratch;

const entry = path.join(scratch, 'entry.ts');
fs.writeFileSync(
  entry,
  `export { StatusLineWatcher, getStatusLineDir, getStatusLineRoot } from ${JSON.stringify(path.join(SRC, 'statusLineWatcher'))};\n` +
    `export * from ${JSON.stringify(path.join(SRC, 'usageLimits'))};\n`
);
const bundle = path.join(scratch, 'bundle.js');
try {
  execSync(
    `npx esbuild ${JSON.stringify(entry)} --bundle --platform=node --format=cjs ` +
      `--alias:vscode=${path.join(ROOT, 'scripts/probes/vscode-stub.js')} --outfile=${JSON.stringify(bundle)} --log-level=error`,
    { cwd: ROOT, stdio: 'inherit' }
  );
} catch {
  check('sources bundle (usageLimits.ts exists)', false, true);
  finish('model-week');
}
const mod = require(bundle);

// A trimmed copy of the answer measured on 2026-09-18.
const measured = {
  limits: [
    {
      kind: 'session',
      group: 'session',
      percent: 11,
      resets_at: '2099-01-01T00:00:00Z',
      scope: null
    },
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: 55,
      resets_at: '2099-01-01T00:00:00Z',
      scope: null
    },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 100,
      severity: 'critical',
      resets_at: '2099-01-01T00:00:00Z',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null }
    }
  ]
};
const rows = typeof mod.parseUsage === 'function' ? mod.parseUsage(measured) : undefined;
check('parseUsage keeps exactly the Fable row', rows && rows.map((r) => [r.name, r.percent]), [
  ['Fable', 100]
]);
check(
  'parseUsage on an unknown shape',
  typeof mod.parseUsage === 'function' ? mod.parseUsage({}) : null,
  undefined
);

const lastDir = path.join(mod.getStatusLineRoot(), 'last');
fs.mkdirSync(lastDir, { recursive: true });
const future = Math.floor(Date.now() / 1000) + 86400;
const writeRows = (list) =>
  fs.writeFileSync(
    path.join(lastDir, 'model-limits.json'),
    JSON.stringify({ rows: list, fetchedAt: Date.now() })
  );
writeRows([{ name: 'Fable', percent: 100, resetsAt: future }]);

const seen = new Map();
const watcher = new mod.StatusLineWatcher((id, snapshot) => seen.set(id, snapshot), 20);
const dir = mod.getStatusLineDir();
fs.mkdirSync(dir, { recursive: true });
const snapshotFor = (model) =>
  JSON.stringify({
    model,
    usedTokens: 1,
    totalTokens: 100,
    usedPercent: 1,
    sessionPercent: 11,
    weekPercent: 55,
    weekResetsAt: 'Sun 12:59 AM',
    updatedAt: Math.floor(Date.now() / 1000)
  });
const pick = (s) => s && { week: s.weekPercent, scope: s.weekScope, all: s.weekAllPercent };

(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  fs.writeFileSync(path.join(dir, 'fable.json'), snapshotFor('Fable 5.1'));
  fs.writeFileSync(path.join(dir, 'opus.json'), snapshotFor('Opus 5 (1M context)'));
  await wait(400);

  check('Fable tab shows Fable week', pick(seen.get('fable')), {
    week: 100,
    scope: 'Fable',
    all: 55
  });
  check('Opus tab shows the account-wide week', pick(seen.get('opus')), {
    week: 55,
    scope: undefined,
    all: undefined
  });
  const limits = JSON.parse(fs.readFileSync(path.join(lastDir, 'limits.json'), 'utf8'));
  check('limits.json keeps the account-wide week', limits.weekPercent, 55);
  check('get() for a webview reload carries the Fable week', pick(watcher.get('fable')), {
    week: 100,
    scope: 'Fable',
    all: 55
  });

  writeRows([{ name: 'Fable', percent: 100, resetsAt: Math.floor(Date.now() / 1000) - 60 }]);
  if (typeof watcher.refreshModelLimits === 'function') watcher.refreshModelLimits();
  check('a row whose window has reset is ignored', pick(seen.get('fable')), {
    week: 55,
    scope: undefined,
    all: undefined
  });

  watcher.dispose();
  fs.rmSync(scratch, { recursive: true, force: true });
  finish('model-week');
})();
