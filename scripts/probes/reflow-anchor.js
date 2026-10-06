/**
 * The bottom visible line stays the bottom visible line while the width changes.
 *
 * xterm anchors the viewport to the bottom only while it sits exactly there; scrolled up, it
 * keeps a line *index*, so lines inserted above by a narrower re-wrap push the content down and
 * lines removed by a wider one let the buffer's base catch up with the viewport — measured
 * 2026-10-06: scrolled up 20 lines, the first widening step landed on the prompt. `fitTerminal`
 * now marks the bottom visible line before each fit and puts it back after it.
 *
 * Same CDP harness as resize-settle.js. The rows are read from xterm's DOM renderer. Red on the
 * webview before the anchor: the scrolled-up series ends on `PROMPT >` after one step.
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
  console.log(`reflow-anchor skipped — no headless Chromium at ${CHROME}`);
  process.exit(0);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-reflow-anchor-'));
for (const file of ['main.js', 'styles.css', 'xterm.css']) {
  fs.copyFileSync(path.join(ROOT, 'media', file), path.join(scratch, file));
}
const lines = [];
// Every word carries its line number, so a continuation row of a wrapped line still says
// which logical line it belongs to — the anchor keeps the logical line, not a particular row.
for (let i = 1; i <= 120; i++) {
  const n = String(i).padStart(3, '0');
  lines.push(`L${n} ${`w${n} `.repeat(27).trim()}`);
}
lines.push('PROMPT > ');
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
send({type:'createTab',id:'t1',name:'Claude 1',awaitingStart:false});send({type:'switchTab',id:'t1'});
window.__feed=()=>send({type:'output',id:'t1',data:${JSON.stringify(lines.join('\r\n'))}});
window.__bottom=()=>{const r=[...document.querySelectorAll('.xterm-rows > div')].map(d=>d.textContent.trim()).filter(t=>t.length>0);const t=r[r.length-1]||'';if(t.startsWith('PROMPT'))return 'PROMPT >';const m=t.match(/\\d{3}/);return m?('L'+m[0]):t.slice(0,8)};
</script></body></html>`
);

const port = 9400 + Math.floor(Math.random() * 1000);
const chrome = spawn(
  CHROME,
  [
    '--headless',
    '--disable-gpu',
    `--remote-debugging-port=${String(port)}`,
    '--window-size=1000,500',
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
  const size = async (width) => {
    await cdp('Emulation.setDeviceMetricsOverride', {
      width,
      height: 500,
      deviceScaleFactor: 1,
      mobile: false
    });
    await frame();
  };
  const bottom = async () =>
    (await cdp('Runtime.evaluate', { expression: 'window.__bottom()', returnByValue: true })).result
      .value;
  const wheelUp = async (times) => {
    for (let i = 0; i < times; i++) {
      await cdp('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: 200,
        y: 200,
        deltaX: 0,
        deltaY: -100
      });
      await frame();
    }
  };

  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await size(1000);
  await cdp('Page.navigate', { url: 'file://' + path.join(scratch, 'index.html') });
  await sleep(500);
  await frame();
  await cdp('Runtime.evaluate', { expression: 'window.__feed()' });
  await sleep(300);
  await frame();
  check('filled, the prompt is the bottom row', await bottom(), 'PROMPT >');

  // 1. at the bottom, narrowing: the prompt stays the bottom row
  const narrowing = [940, 880, 820, 760, 700, 640, 580, 520];
  const atBottom = [];
  for (const width of narrowing) {
    await size(width);
    atBottom.push(await bottom());
  }
  check(
    'at the bottom, narrowing keeps the prompt at the bottom',
    [...new Set(atBottom)],
    ['PROMPT >']
  );
  await sleep(300);
  await frame();
  check('…and after the settle', await bottom(), 'PROMPT >');

  // 2. scrolled up: the same content line stays the bottom row while widening and narrowing
  await wheelUp(4);
  await sleep(200);
  await frame();
  const anchorLine = await bottom();
  check('scrolled up to a history line', /^L\d{3}$/.test(anchorLine), true);
  const seen = [];
  for (const width of [
    580, 640, 700, 760, 820, 880, 940, 1000, 940, 880, 820, 760, 700, 640, 580, 520
  ]) {
    await size(width);
    seen.push(await bottom());
  }
  check(
    'scrolled up, the bottom row is the same line through 16 width steps',
    [...new Set(seen)],
    [anchorLine]
  );
  await sleep(300);
  await frame();
  check('…and after the settle', await bottom(), anchorLine);

  ws.close();
  chrome.kill();
  fs.rmSync(scratch, { recursive: true, force: true });
  finish('reflow anchor');
})().catch((error) => {
  console.error(error);
  chrome.kill();
  process.exit(1);
});
