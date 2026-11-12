/**
 * Progress lists show as chips under the prompt chip — layout A, Daniel, 2026-11-12
 * (`Sessions/Fortschritt-Auftrag.md`).
 *
 * Drives the real webview: a `progress` message opens the bar even without a prompt and takes rows
 * from the terminal; one cell per item; the count; the spinner while running, ❚❚ while paused; the
 * time left from `expectedSeconds`; no × while running, an × once finished whose click posts
 * `dismissProgress` and drops the chip at once; labels arrive as text, never as markup; an empty
 * list gives the rows back.
 *
 * Same CDP harness as activity-prompt.js. Red on the webview before the change: it had no
 * `progress` handler. `PROBE_MAIN_JS` points at another webview bundle.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { check, finish, findHeadlessChrome } = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const CHROME = findHeadlessChrome();
if (!CHROME) {
  console.log('progress-chip skipped — no chrome-headless-shell in ~/Library/Caches/ms-playwright');
  process.exit(0);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-progress-chip-'));
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
window.__progress=l=>send({type:'progress',id:'t1',lists:l});
window.__read=()=>{const bar=document.getElementById('prompt-bar');const chips=[...bar.querySelectorAll('.progress-chip')];const c=chips[0];
const q=s=>c&&c.querySelector(s);
return {barShown:!bar.hidden,chips:chips.length,cells:c?c.querySelectorAll('.progress-cell').length:0,
count:q('.progress-count')?q('.progress-count').textContent:null,time:q('.progress-time')?q('.progress-time').textContent:null,
spinner:!!q('.status-spinner'),mark:q('.progress-mark')?q('.progress-mark').textContent:null,
now:q('.progress-now')?q('.progress-now').textContent:null,bad:q('.progress-bad')?q('.progress-bad').textContent:null,
badTip:q('.progress-bad')?q('.progress-bad').dataset.tooltip:null,close:!!q('.progress-close'),
markup:c?c.querySelectorAll('img,script').length:0,folded:c?c.classList.contains('collapsed'):null,stripShown:!!(q('.progress-strip')&&q('.progress-strip').offsetHeight>0),expanded:q('.progress-toggle')?q('.progress-toggle').getAttribute('aria-expanded'):null,chipH:c?Math.round(c.getBoundingClientRect().height):0,
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

const items = (failedNote) =>
  Array.from({ length: 28 }, (_, i) => {
    if (i < 12) {
      return i === 5
        ? {
            id: 'contrast',
            label: 'contrast',
            state: 'failed',
            note: failedNote,
            log: '/tmp/c.log'
          }
        : { id: `r${String(i)}`, label: `run ${String(i)}`, state: 'ok', seconds: 40 };
    }
    if (i === 12)
      return { id: 'window', label: 'window', state: 'running', startedAt: Date.now() - 42_000 };
    return { id: `p${String(i)}`, label: `<img src=x onerror="window.__xss=1">`, state: 'pending' };
  });
const running = (extra) => ({
  id: 'kuza-check',
  title: 'kuza check',
  state: 'running',
  startedAt: Date.now() - 871_000,
  updatedAt: Date.now(),
  expectedSeconds: 1900,
  items: items('contrast 1.89:1'),
  ...extra
});

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
  const show = async (lists) => {
    await evaluate(`window.__progress(${JSON.stringify(lists)})`);
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
  const fresh = await evaluate('window.__read()');
  check('no list, no prompt: bar hidden', fresh.barShown, false);

  // 1. running, no prompt: the bar opens for the chip alone and takes rows from the terminal
  const run = await show([running()]);
  check('running: bar shown without a prompt', run.barShown, true);
  check('running: one chip', run.chips, 1);
  check('running: one cell per item', run.cells, 28);
  check('running: count of finished items', run.count, '12 / 28');
  check('running: spinner', run.spinner, true);
  check('running: time left from expectedSeconds', /^14:3\d · ~18 min left$/.test(run.time), true);
  check('running: the running item and its time', /^window 4\d s$/.test(run.now), true);
  check('running: failed item named', run.bad, '1 failed: contrast');
  check(
    'running: note and log in the tooltip',
    run.badTip,
    'contrast\ncontrast 1.89:1\n/tmp/c.log'
  );
  check('running: no ×', run.close, false);
  check('labels are text, not markup', run.markup, 0);
  check('chip takes rows from the terminal', run.rows < fresh.rows, true);
  check('starts folded', run.folded, true);
  check('folded: no strip', run.stripShown, false);
  check('folded: aria-expanded false', run.expanded, 'false');

  // 1b. the head line opens and folds it (Daniel, 2026-11-12)
  const toggle = async () => {
    await evaluate("document.querySelector('.progress-toggle').click()");
    await settle();
    return evaluate('window.__read()');
  };
  const opened = await toggle();
  check('click: open', opened.folded, false);
  check('open: strip shown', opened.stripShown, true);
  check('open: aria-expanded true', opened.expanded, 'true');
  check('open: taller', opened.chipH > run.chipH, true);
  check('open: terminal loses rows', opened.rows < run.rows, true);
  const again = await show([running()]);
  check('open survives a new write of the same list', again.folded, false);
  const folded = await toggle();
  check('second click: folded', folded.folded, true);
  check('folded: rows back', folded.rows, run.rows);
  await toggle();

  // 2. paused between two items
  const paused = await show([
    running({
      items: items('x').map((item) =>
        item.state === 'running' ? { ...item, state: 'pending' } : item
      ),
      paused: { reason: 'CPU throttled', since: Date.now() - 38_000 }
    })
  ]);
  check('paused: no spinner', paused.spinner, false);
  check('paused: pause mark', paused.mark, '❚❚');
  check(
    'paused: reason and next item',
    /^Paused 3\d s · CPU throttled · next: window$/.test(paused.now),
    true
  );

  // 3. finished: an ×, and its click goes to the host and drops the chip at once
  const done = await show([running({ state: 'done', updatedAt: Date.now() })]);
  check('done: ×', done.close, true);
  check('done: passed count', done.now, '11 passed');
  await evaluate("document.querySelector('.progress-close').click()");
  await settle();
  const posted = await evaluate(
    "window.__posted.filter(m => m.type === 'dismissProgress').map(m => m.id + '/' + m.listId)"
  );
  check('×: posts dismissProgress', posted, ['t1/kuza-check']);
  const dismissed = await evaluate('window.__read()');
  check('×: chip gone at once', dismissed.chips, 0);
  check('×: rows back', dismissed.rows, fresh.rows);
  check('no script ran from a label', await evaluate('window.__xss || 0'), 0);

  ws.close();
  chrome.kill();
  fs.rmSync(scratch, { recursive: true, force: true });
  finish('progress chip');
})().catch((error) => {
  console.error(error);
  chrome.kill();
  process.exit(1);
});
