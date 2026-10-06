/**
 * A burst of viewport sizes reaches the host as one `resize`, not one per frame.
 *
 * Measured 2026-10-06 in the Claude Terminal output channel: a sidebar drag produced 45 resize
 * lines in 7 s, and maximizing the secondary sidebar with another part open produced
 * `308x68 → 151x29 → 71x10 → 150x29` within 107 ms. Each one is a SIGWINCH, and Claude Code
 * redraws its whole UI on each (~2 KB, twelve new lines of scrollback on the main screen it runs
 * on since 2.1.291) — the "terminal scrolls wildly" report. The webview must fit
 * xterm at once (it has to look right) but report the PTY size only once the size has settled.
 *
 * Drives the headless webview over CDP with chrome-headless-shell from the Playwright cache
 * (`--dump-dom` delivers no ResizeObserver callbacks; a captured screenshot forces the frame).
 * Red on the webview before the settle: 12 posts for 12 sizes, and a 107 ms four-step maximize
 * sequence posts four.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { check, finish } = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const CHROME = path.join(
  os.homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell'
);
if (!fs.existsSync(CHROME)) {
  console.log(`resize-settle skipped — no headless Chromium at ${CHROME}`);
  process.exit(0);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-resize-settle-'));
for (const file of ['main.js', 'styles.css', 'xterm.css']) {
  fs.copyFileSync(path.join(ROOT, 'media', file), path.join(scratch, file));
}
fs.writeFileSync(
  path.join(scratch, 'index.html'),
  `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link href="xterm.css" rel="stylesheet"><link href="styles.css" rel="stylesheet">
<style>:root{--vscode-foreground:#ccc;--vscode-editor-background:#1f1f1f;--vscode-font-family:sans-serif;--vscode-editor-font-family:Menlo}
body{margin:0;background:#1f1f1f;width:100vw;height:100vh;overflow:hidden}</style></head><body class="vscode-dark">
<div id="group-bar"></div><div id="body-row"><div id="terminal-column"><div id="terminals-container"></div><div id="status-line" hidden></div></div><div id="tab-bar"></div></div>
<script>window.__posted=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.__posted.push(m)});</script>
<script src="main.js"></script>
<script>const send=d=>window.dispatchEvent(new MessageEvent('message',{data:d}));
send({type:'createTab',id:'t1',name:'Claude 1',awaitingStart:false});send({type:'switchTab',id:'t1'});</script></body></html>`
);

const port = 9333 + Math.floor(Math.random() * 1000);
const chrome = spawn(
  CHROME,
  [
    '--headless',
    '--disable-gpu',
    `--remote-debugging-port=${String(port)}`,
    '--window-size=480,400',
    'about:blank'
  ],
  { stdio: 'ignore' }
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  let targets;
  for (let attempt = 0; attempt < 50 && !targets; attempt++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${String(port)}/json`)).json();
    } catch {
      await sleep(100);
    }
  }
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve) => (ws.onopen = resolve));
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message.result);
      pending.delete(message.id);
    }
  };
  const cdp = (method, params = {}) =>
    new Promise((resolve) => {
      pending.set(++nextId, resolve);
      ws.send(JSON.stringify({ id: nextId, method, params }));
    });
  const frame = () =>
    cdp('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: 8, height: 8, scale: 1 }
    });
  const size = async (width, height) => {
    await cdp('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false
    });
    await frame();
  };
  const posted = async () =>
    JSON.parse(
      (
        await cdp('Runtime.evaluate', {
          expression:
            'JSON.stringify(window.__posted.filter(m=>m.type==="resize").map(m=>m.cols+"x"+m.rows))',
          returnByValue: true
        })
      ).result.value
    );

  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await size(480, 400);
  await cdp('Page.navigate', { url: 'file://' + path.join(scratch, 'index.html') });
  await sleep(500);
  await frame();
  const startup = (await posted()).length;

  // A drag: twelve widths, a frame apart
  for (const width of [500, 540, 600, 680, 760, 840, 920, 1000, 1080, 1160, 1240, 1300]) {
    await size(width, 400);
  }
  await sleep(400);
  await frame();
  const afterDrag = await posted();
  check('a twelve-step drag reports once', afterDrag.length - startup, 1);
  check('…with the final size', afterDrag[afterDrag.length - 1], '172x21');

  // The measured maximize sequence: huge, normal, sliver, normal — within ~110 ms
  const steps = [
    [1800, 1200],
    [900, 400],
    [480, 80],
    [900, 400]
  ];
  for (const [width, height] of steps) {
    await size(width, height);
    await sleep(25);
  }
  await sleep(400);
  await frame();
  const afterMaximize = await posted();
  const maximizePosts = afterMaximize.slice(afterDrag.length);
  check('the maximize sequence reports once', maximizePosts.length, 1);
  check(
    '…never a sliver',
    maximizePosts.some((s) => /x[1-4]$/.test(s)),
    false
  );

  // The same size again after a quiet moment is not reported again
  await size(900, 400);
  await sleep(400);
  await frame();
  check('an unchanged size is not re-reported', (await posted()).length, afterMaximize.length);

  ws.close();
  chrome.kill();
  fs.rmSync(scratch, { recursive: true, force: true });
  finish('resize settle');
})().catch((error) => {
  console.error(error);
  chrome.kill();
  process.exit(1);
});
