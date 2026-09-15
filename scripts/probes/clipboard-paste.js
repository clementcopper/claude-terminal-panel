/**
 * Probe: what a paste into the panel becomes, read from the real pasteboard.
 *
 * Bundles `src/clipboardPaste.ts` with the vscode stub (its `env.clipboard.readText` is
 * `pbpaste`, the same text a browser paste delivers) and runs it against whatever is on the
 * pasteboard right now. Copy a file in Finder first: before the fix the panel pasted only what
 * `pbpaste` shows — the bare file name — and Claude Code's Ctrl+V read the file's icon; the
 * module must answer with the absolute path of the copied file. With plain text on the
 * pasteboard it must answer `text` without an osascript round trip (well under 100 ms).
 */
const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { check, finish } = require('./lib');

if (process.platform !== 'darwin') {
  console.log('clipboard-paste: macOS only, skipped');
  process.exit(0);
}

const root = path.resolve(__dirname, '..', '..');
const out = path.join(os.tmpdir(), 'claude-terminal-panel-probe', 'clipboardPaste.js');
fs.mkdirSync(path.dirname(out), { recursive: true });
execSync(
  `npx esbuild src/clipboardPaste.ts --bundle --platform=node --format=cjs ` +
    `--alias:vscode=${path.join(root, 'scripts/probes/vscode-stub.js')} --outfile=${out} --log-level=warning`,
  { cwd: root, stdio: 'inherit' }
);
const { readPasteboard } = require(out);

const browserText = execFileSync('pbpaste', { encoding: 'utf8' });
let furl = '';
try {
  furl = execFileSync('osascript', ['-e', 'get POSIX path of (the clipboard as «class furl»)'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim();
} catch {
  // no file on the pasteboard
}

(async () => {
  const started = Date.now();
  const content = await readPasteboard();
  const ms = Date.now() - started;
  console.log(
    `pasteboard: pbpaste=${JSON.stringify(browserText.slice(0, 80))} furl=${JSON.stringify(furl)} → ${JSON.stringify(content)} in ${ms} ms`
  );

  if (furl && fs.existsSync(furl)) {
    // A copied file: the browser text is the bare name, the module must find the file.
    check('browser paste would be a bare name', path.isAbsolute(browserText.trim()), false);
    check('kind for a copied file', content.kind, 'path');
    check('path is the copied file', content.text, furl);
  } else if (browserText.length > 0) {
    check('kind for text', content.kind, 'text');
    check('text unchanged', content.text, browserText);
    check('no osascript round trip for text (< 100 ms)', ms < 100, true);
  } else {
    check('kind without text', ['image', 'none'].includes(content.kind), true);
  }
  finish('clipboard-paste');
})();
