/**
 * The status row says that something is at work and for how long, and the bar above the terminal
 * shows the person's last prompt — Daniel, 2026-11-07, with several sessions in parallel.
 *
 * Busy: a spinner, then the run time — the tool's since its `startedAt`, else the turn's since
 * `stateAt` — then the tool or the directory; the time moves once a second without a new
 * snapshot. The bar is hidden without a prompt, one line with an ellipsis otherwise, the whole
 * prompt in its tooltip, tinted with the tab's `/color`; showing it takes rows from the terminal.
 *
 * Same CDP harness as file-link-wrap.js. Red on the webview before the change.
 * `PROBE_MAIN_JS` points at another webview bundle.
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
    'activity-prompt skipped — no chrome-headless-shell in ~/Library/Caches/ms-playwright'
  );
  process.exit(0);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-activity-prompt-'));
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
window.__rows=()=>document.querySelectorAll('#terminal-t1 .xterm-rows > div').length;
window.__status=d=>send({type:'statusLine',id:'t1',data:d});
window.__read=()=>{const bar=document.getElementById('prompt-bar');const text=bar&&bar.querySelector('.prompt-line.said .prompt-text');const bt=bar&&bar.querySelector('.prompt-line.before .prompt-text');const bm=bar&&bar.querySelector('.prompt-line.before .prompt-mark');
const el=document.querySelector('.status-elapsed');const cwd=document.querySelector('.status-cwd');
return {before:bt?bt.textContent:null,beforeMark:bm?bm.textContent:null,beforeColor:bm?getComputedStyle(bm).color:null,beforeCut:bt?bt.scrollWidth>bt.clientWidth:null,barShown:!!bar&&!bar.hidden,barText:text?text.textContent:null,barTooltip:bar?bar.dataset.tooltip||null:null,
barCut:text?text.scrollWidth>text.clientWidth:null,tint:bar?bar.style.getPropertyValue('--prompt-tint'):null,
spinner:!!document.querySelector('.status-spinner'),elapsed:el?el.textContent:null,row:cwd?cwd.textContent:null,rows:window.__rows()}};
</script></body></html>`
);

const port = 9400 + Math.floor(Math.random() * 1000);
const chrome = spawn(
  CHROME,
  [
    '--headless',
    '--disable-gpu',
    `--remote-debugging-port=${String(port)}`,
    '--window-size=420,600',
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

  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 420,
    height: 600,
    deviceScaleFactor: 1,
    mobile: false
  });
  await cdp('Page.navigate', { url: 'file://' + path.join(scratch, 'index.html') });
  await sleep(500);
  await frame();

  const PROMPT =
    'Die Links funktionieren jetzt – aber nur ohne Zeilenumbruch, im schmalen Panel geht es nicht. Wäre gut, wenn es auch mit Umbruch ginge';
  const base = {
    model: 'Opus 5.5',
    cwd: '~/claude-terminal-panel',
    usedTokens: 1000,
    totalTokens: 200000,
    usedPercent: 0.5,
    updatedAt: Math.round(Date.now() / 1000)
  };
  const show = async (extra) => {
    await evaluate(`window.__status(${JSON.stringify({ ...base, ...extra })})`);
    await sleep(150);
    await frame();
    await sleep(150);
    await frame();
    return evaluate('window.__read()');
  };

  // 1. a fresh session: no prompt, no bar; idle, no spinner
  const fresh = await show({ state: 'idle' });
  check('no prompt: no bar', fresh.barShown, false);
  check('idle: no spinner', fresh.spinner, false);
  check('idle: the row is the directory', fresh.row, '~/claude-terminal-panel');

  // 2. a tool runs since 42 s: spinner, run time first, then the tool
  const now = Date.now();
  const tool = await show({
    state: 'busy',
    stateAt: now - 72_000,
    tool: { name: 'Bash', summary: 'npm test', startedAt: now - 42_000 },
    prompt: PROMPT,
    color: 'pink'
  });
  check('a tool runs: spinner', tool.spinner, true);
  check('a tool runs: its run time', /^4[2-4] s$/.test(tool.elapsed ?? ''), true);
  check('a tool runs: the tool after the time', tool.row, 'Bash · npm test');

  // 3. the prompt bar: shown, cut to one line, whole in the tooltip, tinted pink, terminal shorter
  check('prompt: bar shown', tool.barShown, true);
  check('prompt: the text', tool.barText, PROMPT);
  check('prompt: cut to one line', tool.barCut, true);
  check('prompt: whole in the tooltip', tool.barTooltip, PROMPT);
  check('prompt: tinted with the tab colour', tool.tint, 'rgb(196, 102, 134)');
  check('prompt: the terminal lost rows to the bar', tool.rows < fresh.rows, true);
  check('prompt: no line before it without a summary', tool.before, null);

  // 3b. the line about Claude's answer before the prompt: above it, in the same fill, cut, both in
  // the tooltip, the spark in Claude's orange; one more line taken from the terminal
  const BEFORE =
    'Datei-Links im Terminal: Bildpfade öffnen jetzt, Umbruch noch offen, Probe rot gegen HEAD';
  const withBefore = await show({ state: 'idle', prompt: PROMPT, before: BEFORE, color: 'pink' });
  check('before: the line', withBefore.before, BEFORE);
  check('before: the spark', withBefore.beforeMark, '✻');
  check('before: in Claude orange', withBefore.beforeColor, 'rgb(217, 119, 87)');
  check('before: cut to one line', withBefore.beforeCut, true);
  check('before: the prompt still below', withBefore.barText, PROMPT);
  check('before: both in the tooltip', withBefore.barTooltip, `✻ ${BEFORE}\n❯ ${PROMPT}`);
  check('before: the terminal lost another row', withBefore.rows < tool.rows, true);

  // 4. the time moves on its own
  await show({
    ...{ state: 'busy' },
    stateAt: now - 72_000,
    tool: { name: 'Bash', summary: 'npm test', startedAt: now - 42_000 },
    prompt: PROMPT,
    color: 'pink'
  });
  await sleep(2100);
  const later = await evaluate('window.__read()');
  check('the run time moves without a new snapshot', later.elapsed !== tool.elapsed, true);

  // 5. busy between tools: the turn's time, then the directory
  const thinking = await show({ state: 'busy', stateAt: Date.now() - 72_000, prompt: PROMPT });
  check('thinking: spinner', thinking.spinner, true);
  check('thinking: the turn time', /^1:1[2-4]$/.test(thinking.elapsed ?? ''), true);
  check('thinking: the directory after it', thinking.row, '~/claude-terminal-panel');

  // 6. done: no spinner, the prompt stays
  const idle = await show({ state: 'idle', prompt: PROMPT });
  check('done: no spinner', idle.spinner, false);
  check('done: the prompt stays', idle.barShown, true);

  // 7. /clear: the prompt goes, the terminal gets its rows back
  const cleared = await show({ state: 'idle' });
  check('cleared: bar hidden', cleared.barShown, false);
  check('cleared: rows back', cleared.rows, fresh.rows);

  ws.close();
  chrome.kill();
  fs.rmSync(scratch, { recursive: true, force: true });
  finish('activity and prompt bar');
})().catch((error) => {
  console.error(error);
  chrome.kill();
  process.exit(1);
});
