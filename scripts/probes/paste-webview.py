"""
The webview side of paste, headless: Cmd+V and Ctrl+V in a tab post `pasteRequest` and nothing
else, `pasteText` reaches the PTY through xterm's own paste (bracketed only once the CLI asked
for it), and a dropped file arrives at the host as `dropFiles` with its bytes.

Needs the Playwright Python package (see .claude/rules/probes.md) and a compiled media/main.js;
an optional argument names another main.js to probe (the previous build, to see the probe red).
"""
import base64, os, shutil, sys, tempfile
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MEDIA = os.path.join(ROOT, 'media')
MAIN_JS = sys.argv[1] if len(sys.argv) > 1 else os.path.join(MEDIA, 'main.js')

PAGE = """<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<link href="xterm.css" rel="stylesheet"><link href="styles.css" rel="stylesheet">
<style>body{margin:0;background:#1f1f1f;width:480px;height:320px;overflow:hidden}</style>
</head><body class="vscode-dark">
<div id="group-bar"></div><div id="body-row"><div id="terminal-column"><div id="terminals-container"></div><div id="status-line" hidden></div></div><div id="tab-bar"></div></div>
<script>window.__posted=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.__posted.push(m)});</script>
<script src="main.js"></script>
<script>
const send=d=>window.dispatchEvent(new MessageEvent('message',{data:d}));
send({type:'createTab',id:'t1',name:'Claude 1',awaitingStart:false});
send({type:'tabsUpdate',tabs:[{id:'t1',name:'Claude 1',isActive:true,accentColor:'#d97757',engine:'claude',cwd:'/x'}]});
send({type:'switchTab',id:'t1'});
</script></body></html>"""

failures = []
def check(name, actual, expected):
    ok = actual == expected
    print(f"{'✓' if ok else '✗'} {name}: {actual!r}" + ('' if ok else f' (expected {expected!r})'))
    if not ok:
        failures.append(name)

tmp = tempfile.mkdtemp(prefix='probe-paste-')
shutil.copy(MAIN_JS, os.path.join(tmp, 'main.js'))
for f in ('styles.css', 'xterm.css'):
    shutil.copy(os.path.join(MEDIA, f), tmp)
with open(os.path.join(tmp, 'index.html'), 'w') as fh:
    fh.write(PAGE)

DROP = b'\x89PNG\r\n\x1a\n' + bytes(range(256))

with sync_playwright() as p:
    browser = p.chromium.launch()
    # The key handler is macOS-only and reads the user agent, so the probe says what it is.
    page = browser.new_page(viewport={'width': 480, 'height': 320},
                            user_agent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130')
    page.goto('file://' + tmp + '/index.html')
    page.wait_for_timeout(300)
    posted = lambda: page.evaluate('() => window.__posted.splice(0)')

    page.focus('.xterm-helper-textarea')
    page.wait_for_timeout(50)
    posted()
    page.keyboard.press('Meta+v')
    page.wait_for_timeout(100)
    got = posted()
    check('Cmd+V posts pasteRequest for the tab', [m for m in got if m['type'] == 'pasteRequest'], [{'type': 'pasteRequest', 'id': 't1'}])
    check('Cmd+V writes nothing into the PTY', [m for m in got if m['type'] == 'input'], [])

    page.wait_for_timeout(300)
    page.keyboard.press('Control+v')
    page.wait_for_timeout(100)
    got = posted()
    check('Ctrl+V posts pasteRequest', [m['type'] for m in got], ['pasteRequest'])

    # VS Code fires its own paste command into the webview on top of the keydown: one gesture
    # must stay one request, and a paste event on its own (context menu) must still become one.
    page.evaluate('''() => {
      const dt = new DataTransfer(); dt.setData('text/plain', 'shot.png');
      document.querySelector('.xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true}));
    }''')
    page.wait_for_timeout(100)
    got = posted()
    check('a paste event right after the key is folded into it', got, [])
    page.wait_for_timeout(300)
    page.evaluate('''() => {
      const dt = new DataTransfer(); dt.setData('text/plain', 'shot.png');
      document.querySelector('.xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true}));
    }''')
    page.wait_for_timeout(100)
    got = posted()
    check('a paste event on its own posts pasteRequest, no PTY text', [m['type'] for m in got], ['pasteRequest'])

    page.keyboard.type('a')
    page.wait_for_timeout(100)
    check('a plain key still reaches the PTY', [m.get('data') for m in posted() if m['type'] == 'input'], ['a'])

    page.evaluate('''() => window.dispatchEvent(new MessageEvent('message', {data: {type: 'pasteText', id: 't1', text: '/tmp/a b.png'}}))''')
    page.wait_for_timeout(100)
    check('pasteText before CSI ?2004h is bare', [m.get('data') for m in posted() if m['type'] == 'input'], ['/tmp/a b.png'])

    page.evaluate('''() => window.dispatchEvent(new MessageEvent('message', {data: {type: 'output', id: 't1', data: '\\x1b[?2004h'}}))''')
    page.wait_for_timeout(100)
    page.evaluate('''() => window.dispatchEvent(new MessageEvent('message', {data: {type: 'pasteText', id: 't1', text: '/tmp/a b.png'}}))''')
    page.wait_for_timeout(100)
    check('pasteText after CSI ?2004h is bracketed', [m.get('data') for m in posted() if m['type'] == 'input'], ['\x1b[200~/tmp/a b.png\x1b[201~'])

    page.evaluate('''(bytes) => {
      const file = new File([new Uint8Array(bytes)], 'shot.png', {type: 'image/png'});
      const dt = new DataTransfer(); dt.items.add(file);
      const target = document.getElementById('terminals-container');
      target.dispatchEvent(new DragEvent('dragover', {dataTransfer: dt, bubbles: true, cancelable: true}));
      target.dispatchEvent(new DragEvent('drop', {dataTransfer: dt, bubbles: true, cancelable: true}));
    }''', list(DROP))
    page.wait_for_timeout(300)
    drops = [m for m in posted() if m['type'] == 'dropFiles']
    check('drop posts dropFiles for the active tab', [(m['id'], [f['name'] for f in m['files']]) for m in drops], [('t1', ['shot.png'])])
    check('dropped bytes arrive intact', drops[0]['files'][0]['data'] == base64.b64encode(DROP).decode() if drops else None, True)

    browser.close()

if failures:
    print(f"\x1b[31m✗ paste-webview: {len(failures)} check(s) failed\x1b[0m")
    sys.exit(1)
print("\x1b[32m✓ paste-webview\x1b[0m")
