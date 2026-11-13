/**
 * The process monitor's webview half (`media/shellChip.ts`, Daniel 2026-11-13): Claude's Bash
 * calls as chips in the progress chip's form, and a list-writing call's output inside its list.
 *
 * Same CDP harness as progress-chip.js. Checks: a `shells` message opens the bar; a call chip
 * starts folded with spinner, command and time; open, it shows an output box of fixed height with
 * the last lines and a cursor; colour codes become classes and markup stays text; a failed call
 * shows `exit 3` and an ×, whose click posts `dismissShell` and drops the chip; a call that feeds a
 * running progress list gets no chip of its own and its output shows in the opened list chip,
 * and stays there after the call is gone. Red before the change: no `shells` handler.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { check, finish, findHeadlessChrome } = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const CHROME = findHeadlessChrome();
if (!CHROME) {
  console.log('shell-chip skipped — no chrome-headless-shell in ~/Library/Caches/ms-playwright');
  process.exit(0);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-shell-chip-'));
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
<div id="group-bar"></div><div id="body-row"><div id="terminal-column"><div id="prompt-bar" hidden></div><div id="terminals-container"></div><div id="status-line" hidden></div></div><div id="tab-bar"></div></div>
<script>window.__posted=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.__posted.push(m)});</script>
<script src="main.js"></script>
<script>const send=d=>window.dispatchEvent(new MessageEvent('message',{data:d}));
send({type:'createTab',id:'t1',name:'Claude 1',awaitingStart:false});send({type:'switchTab',id:'t1'});
window.__progress=l=>send({type:'progress',id:'t1',lists:l});window.__shells=s=>send({type:'shells',id:'t1',shells:s});
window.__read=()=>{const bar=document.getElementById('prompt-bar');const sc=bar.querySelector('.shell-chip');const pc=bar.querySelector('.progress-chip:not(.shell-chip)');
const out=bar.querySelector('.shell-out');
return {barShown:!bar.hidden,shellChips:bar.querySelectorAll('.shell-chip').length,folded:sc?sc.classList.contains('collapsed'):null,
title:sc&&sc.querySelector('.progress-title')?sc.querySelector('.progress-title').textContent:null,spinner:!!(sc&&sc.querySelector('.status-spinner')),
time:sc&&sc.querySelector('.progress-time')?sc.querySelector('.progress-time').textContent:null,
out:!!out,outH:out?Math.round(out.getBoundingClientRect().height):0,outLines:out?out.querySelectorAll('.shell-line').length:0,
outText:out?[...out.querySelectorAll('.shell-line')].map(l=>l.textContent):[],cursor:!!(out&&out.querySelector('.shell-cursor')),
green:out?out.querySelectorAll('.ansi-green').length:0,markup:bar.querySelectorAll('.shell-out img,.shell-out script').length,
exit:sc&&sc.querySelector('.progress-fail-count')?sc.querySelector('.progress-fail-count').textContent:null,close:!!(sc&&sc.querySelector('.progress-close')),
inList:!!(pc&&pc.querySelector('.shell-out')),
input:out?[...out.querySelectorAll('.shell-input')].map(l=>l.textContent):[],
scroll:out?{top:Math.round(out.scrollTop),end:Math.round(out.scrollHeight-out.clientHeight)}:null,
rows:document.querySelectorAll('#terminal-t1 .xterm-rows > div').length}};
</script></body></html>`
);

const W = 420;
const H = 600;
const port = 9400 + Math.floor(Math.random() * 1000);
const chrome = spawn(
  CHROME,
  [
    '--headless',
    '--disable-gpu',
    `--remote-debugging-port=${String(port)}`,
    `--window-size=${String(W)},${String(H)}`,
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
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await sleep(150);
      await frame();
    }
  };

  const t0 = Date.now();
  const shell = (extra) => ({
    key: 'b1',
    command: 'npm run watch',
    startedAt: t0 - 72_000,
    background: true,
    state: 'running',
    lines: Array.from({ length: 12 }, (_, i) =>
      i === 11 ? '\x1b[32m✓ built\x1b[0m <img src=x onerror="window.__xss=1">' : `line ${i}`
    ),
    readable: true,
    ...extra
  });
  const show = async (shells, lists) => {
    if (lists) await evaluate(`window.__progress(${JSON.stringify(lists)})`);
    await evaluate(`window.__shells(${JSON.stringify(shells)})`);
    await settle();
    return evaluate('window.__read()');
  };
  const click = async (sel) => {
    await evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);
    await settle();
    return evaluate('window.__read()');
  };

  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: W,
    height: H,
    deviceScaleFactor: 1,
    mobile: false
  });
  await cdp('Page.navigate', { url: 'file://' + path.join(scratch, 'index.html') });
  await sleep(500);
  await settle();

  const folded = await show([shell()]);
  check('running call: bar shown', folded.barShown, true);
  check('running call: one chip', folded.shellChips, 1);
  check('starts folded, no output', [folded.folded, folded.out], [true, false]);
  check('head: command', folded.title, 'npm run watch');
  check('head: spinner', folded.spinner, true);
  check('head: run time', /^1:1\d$/.test(folded.time), true);

  const open = await click('.shell-chip .progress-toggle');
  check('click opens: output box', open.out, true);
  check(
    'open: the command, all 12 lines and the cursor row',
    [open.input, open.outLines, open.cursor],
    [['$ npm run watch'], 14, true]
  );
  check(
    'open: newest line last, markup as text',
    open.outText[12],
    '✓ built <img src=x onerror="window.__xss=1">'
  );
  check(
    'open: scrolled to the newest line',
    open.scroll.top > 0 && open.scroll.top === open.scroll.end,
    true
  );
  const grown = await show([shell({ lines: [...shell().lines, 'line 12'] })]);
  check(
    'a new line at the end: follows it',
    grown.scroll.top === grown.scroll.end && grown.scroll.end > open.scroll.end,
    true
  );
  await evaluate("document.querySelector('.shell-out').scrollTop = 0");
  const kept = await show([shell({ lines: [...shell().lines, 'line 12', 'line 13'] })]);
  check('scrolled up: a new line leaves it where it was', kept.scroll.top, 0);
  check('box height unchanged by the scroll content', kept.outH, open.outH);
  // PROBE_SHOT=<file.png> keeps a picture of the open box, scrolled to the end
  if (process.env.PROBE_SHOT) {
    await evaluate(
      "(b => { b.scrollTop = b.scrollHeight; b.dispatchEvent(new Event('scroll')); })(document.querySelector('.shell-out'))"
    );
    await settle();
    const shot = await cdp('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: W, height: 260, scale: 2 }
    });
    fs.writeFileSync(process.env.PROBE_SHOT, Buffer.from(shot.data, 'base64'));
  }
  check('open: colour code becomes a class', open.green, 1);
  check('open: no element from the output', open.markup, 0);
  check('open: terminal gives rows', open.rows < folded.rows, true);
  const fewer = await show([shell({ lines: ['only one'] })]);
  check('box keeps its height with fewer lines', fewer.outH, open.outH);

  const failed = await show([shell({ state: 'failed', exitCode: 3, endedAt: t0 })]);
  check('failed: exit code in the head', failed.exit, 'exit 3');
  check('failed: ×, no cursor', [failed.close, failed.cursor], [true, false]);
  await click('.shell-chip .progress-close');
  const posted = await evaluate(
    "window.__posted.filter(m => m.type === 'dismissShell').map(m => m.id + '/' + m.key)"
  );
  check('×: posts dismissShell', posted, ['t1/b1']);
  check('×: chip gone at once', (await evaluate('window.__read()')).shellChips, 0);

  // a call that writes a progress list: no chip of its own, its output inside the list
  const list = {
    id: 'kuza-check',
    title: 'kuza check',
    state: 'running',
    startedAt: t0,
    updatedAt: t0,
    items: [{ id: 'a', label: 'a', state: 'running', startedAt: t0 }]
  };
  const fg = {
    key: 'f1',
    command: 'node cli/kuza.mjs check',
    startedAt: t0 - 1000,
    background: false,
    state: 'running',
    lines: ['start a'],
    readable: true
  };
  const linked = await show([fg], [list]);
  check('feeding call: no own chip', linked.shellChips, 0);
  check('folded list: no output', linked.inList, false);
  await click('.progress-chip .progress-toggle');
  check('opened list: output inside', (await evaluate('window.__read()')).inList, true);
  const after = await show([]);
  check(
    'call gone: command and output stay in the list',
    [after.inList, after.outText[0], after.outText[1]],
    [true, '$ node cli/kuza.mjs check', 'start a']
  );
  const unrelated = await show([
    { ...fg, key: 'w1', command: 'npm run watch', startedAt: t0 - 3_600_000, lines: ['watching'] }
  ]);
  check('an hour-old call is not the list writer', unrelated.shellChips, 1);
  check('no script ran from output', await evaluate('window.__xss || 0'), 0);

  ws.close();
  chrome.kill();
  fs.rmSync(scratch, { recursive: true, force: true });
  finish('shell chip');
})().catch((error) => {
  console.error(error);
  chrome.kill();
  process.exit(1);
});
