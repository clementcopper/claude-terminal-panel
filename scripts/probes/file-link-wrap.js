/**
 * A file path that wraps onto the next row is still one link, from either row.
 *
 * Claude Code wraps a word longer than the panel itself: it fills the row to the last column
 * and continues on the next row after a two-space indent — measured 2026-11-07 on a raw
 * node-pty capture at 50 columns, a 110-character scratchpad path came as 48 + 48 + 14
 * characters, written with cursor moves, so xterm's `isWrapped` stays false. The provider used
 * to read one row at a time, and neither half was a link. Plain shell output wraps softly
 * (`isWrapped`), which has to work as well.
 *
 * Same CDP harness as reflow-anchor.js. Clicks go through xterm's own linkifier: hover, then
 * mousedown/mouseup on a character, then read the `openFile` message the webview posts.
 * Red on the webview before the change: both wrapped cases post nothing.
 *
 * `PROBE_MAIN_JS` points at another webview bundle (the old state, to see it red).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { check, finish, findHeadlessChrome } = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const CHROME = findHeadlessChrome();
if (!CHROME) {
  console.log(
    'file-link-wrap skipped — no chrome-headless-shell in ~/Library/Caches/ms-playwright'
  );
  process.exit(0);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-file-link-wrap-'));
fs.copyFileSync(
  process.env.PROBE_MAIN_JS || path.join(ROOT, 'media', 'main.js'),
  path.join(scratch, 'main.js')
);
for (const file of ['styles.css', 'xterm.css']) {
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
send({type:'createTab',id:'t1',name:'Claude 1',awaitingStart:false});send({type:'switchTab',id:'t1'});
window.__write=s=>send({type:'output',id:'t1',data:s});
window.__rows=()=>[...document.querySelectorAll('#terminal-t1 .xterm-rows > div')];
// Screen position of character \`index\` in visible row \`row\`, through a DOM Range on the row's text.
window.__at=(row,index)=>{const el=window.__rows()[row];const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let n,left=index;
while((n=walker.nextNode())){if(left<n.length){const r=document.createRange();r.setStart(n,left);r.setEnd(n,left+1);const b=r.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2}}left-=n.length}return null};
window.__opened=()=>window.__posted.filter(m=>m.type==='openFile').map(m=>({path:m.path,line:m.line??null}));
</script></body></html>`
);

const port = 9400 + Math.floor(Math.random() * 1000);
const chrome = spawn(
  CHROME,
  [
    '--headless',
    '--disable-gpu',
    `--remote-debugging-port=${String(port)}`,
    '--window-size=420,500',
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
  const evaluate = async (expression) =>
    (await cdp('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  const write = async (data) => {
    await evaluate(`window.__write(${JSON.stringify(data)})`);
    await sleep(100);
    await frame();
  };
  const fresh = (data) => write('\x1b[2J\x1b[3J\x1b[H' + data);

  /** Hover, then click character `index` of visible row `row`; returns the `openFile` messages. */
  const click = async (row, index) => {
    await evaluate('window.__posted.length = 0');
    const at = await evaluate(`window.__at(${String(row)}, ${String(index)})`);
    if (!at) return 'no such character';
    const mouse = (type) =>
      cdp('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
    // Move away first, so every click starts a fresh hover and xterm asks the providers again.
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
    await sleep(50);
    await mouse('mouseMoved');
    await sleep(150);
    await mouse('mousePressed');
    await mouse('mouseReleased');
    await sleep(100);
    return evaluate('window.__opened()');
  };

  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 420,
    height: 500,
    deviceScaleFactor: 1,
    mobile: false
  });
  await cdp('Page.navigate', { url: 'file://' + path.join(scratch, 'index.html') });
  await sleep(500);
  await frame();

  // The terminal's width in columns: write more than fits, count the first row.
  await fresh('#'.repeat(400));
  const cols = await evaluate('window.__rows()[0].textContent.length');
  check('the terminal is narrower than the path', cols > 20 && cols < 100, true);

  const longPath =
    '/private/tmp/claude-501/-Users-danielmartin-claude-terminal-panel/' +
    '73f7a364-e526-4e66-a060-ac2393667ee9/scratchpad/test.png';

  // 1. soft wrap: xterm breaks the line itself (shell output)
  await fresh('see ' + longPath + '\r\n');
  check('soft wrap, click on row 1', await click(0, 10), [{ path: longPath, line: null }]);
  check('soft wrap, click on row 2', await click(1, 3), [{ path: longPath, line: null }]);

  // 2. hard wrap in Claude's format: `⏺ ` + chunk to the last column, then `  ` + chunk per row
  const first = longPath.slice(0, cols - 2);
  let rest = longPath.slice(cols - 2);
  let hard = '⏺ ' + first;
  while (rest.length > 0) {
    hard += '\r\n  ' + rest.slice(0, cols - 2);
    rest = rest.slice(cols - 2);
  }
  await fresh(hard + '\r\n');
  check('hard wrap, click on row 1', await click(0, 6), [{ path: longPath, line: null }]);
  check('hard wrap, click on row 2', await click(1, 5), [{ path: longPath, line: null }]);
  check('hard wrap, click on the last row', await click(2, 2), [{ path: longPath, line: null }]);

  // 3. a path that ends exactly at the last column after prose does not swallow the next word
  const tail = 'src/foo.ts';
  const prose = 'word '.repeat(Math.ceil(cols / 5));
  const lead = '  ' + prose.slice(0, cols - 2 - tail.length - 1).padEnd(cols - 2 - tail.length - 1);
  await fresh(lead + ' ' + tail + '\r\n  and then more text\r\n');
  check('a path ending at the last column stays itself', await click(0, cols - 3), [
    { path: tail, line: null }
  ]);

  // 4. an ordinary short link with a line number
  await fresh('  see src/extension.ts:113 for it\r\n');
  check('short link with line', await click(0, 8), [{ path: 'src/extension.ts', line: 113 }]);

  // 5. two full rows of prose: nothing to open
  await fresh('x'.repeat(cols) + '\r\n  ' + 'y'.repeat(cols - 2) + '\r\n');
  check('full prose rows are no link', await click(1, 5), []);

  ws.close();
  chrome.kill();
  fs.rmSync(scratch, { recursive: true, force: true });
  finish('file link wrap');
})().catch((error) => {
  console.error(error);
  chrome.kill();
  process.exit(1);
});
