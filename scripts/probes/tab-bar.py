"""
The tab bar, rendered headless with Dark Modern tokens: the waiting pill keeps its contrast on
an inactive tab, tabs are keyboard-reachable, and Enter on a tab posts switchTab.

Needs the Playwright Python package (see .claude/rules/probes.md for the interpreter path) and
a compiled media/main.js. Writes its screenshots next to the temp page and prints the paths.
"""
import json, os, re, shutil, sys, tempfile
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MEDIA = os.path.join(ROOT, 'media')
GROUND = (31, 31, 31)  # Dark Modern editor background, what the bar sits on

PAGE = """<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<link href="xterm.css" rel="stylesheet"><link href="styles.css" rel="stylesheet">
<style>
:root{--vscode-tab-inactiveBackground:#181818;--vscode-tab-activeBackground:#1f1f1f;--vscode-tab-border:#2b2b2b;
--vscode-tab-inactiveForeground:#9d9d9d;--vscode-tab-activeForeground:#ffffff;--vscode-tab-hoverBackground:#1f1f1f;
--vscode-focusBorder:#0078d4;--vscode-notificationsErrorIcon-foreground:#f14c4c;--vscode-foreground:#cccccc;
--vscode-editor-background:#1f1f1f;--vscode-icon-foreground:#cccccc;--vscode-font-family:-apple-system,sans-serif}
body{margin:0;background:#1f1f1f;width:320px;height:240px;overflow:hidden}
</style></head><body class="vscode-dark">
<div id="group-bar"></div><div id="body-row"><div id="terminal-column"><div id="terminals-container"></div><div id="status-line" hidden></div></div><div id="tab-bar"></div></div>
<script>window.__posted=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.__posted.push(m)});</script>
<script src="main.js"></script>
<script>
const send=d=>window.dispatchEvent(new MessageEvent('message',{data:d}));
const acc='#d97757';
for (const n of [1,2,3]) send({type:'createTab',id:'t'+n,name:'Claude '+n,awaitingStart:false});
send({type:'groupsUpdate',groups:[{id:'g1',name:'probe',isActive:true,cwd:'/x',terminalCount:3,hasWaitingTerminal:true,engine:'claude',accentColor:acc}]});
send({type:'tabsUpdate',tabs:[
 {id:'t1',name:'Claude 1',isActive:true,accentColor:acc,engine:'claude',cwd:'/x'},
 {id:'t2',name:'Claude 2',isActive:false,accentColor:acc,engine:'claude',cwd:'/x',isWaitingForInput:true},
 {id:'t3',name:'Claude 3',isActive:false,accentColor:acc,engine:'claude',cwd:'/x'}]});
send({type:'switchTab',id:'t1'});
send({type:'setNotification',id:'t2',show:true});
</script></body></html>"""

def lum(rgb):
    def c(v):
        v = v / 255
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = rgb
    return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b)

def contrast(a, b):
    la, lb = lum(a), lum(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)

def rgb(s):
    return tuple(float(x) for x in re.findall(r'[\d.]+', s)[:3])

failures = []
def check(name, actual, expected):
    ok = actual == expected
    print(f"{'✓' if ok else '✗'} {name}: {actual!r}" + ('' if ok else f' (expected {expected!r})'))
    if not ok:
        failures.append(name)

tmp = tempfile.mkdtemp(prefix='probe-tab-bar-')
for f in ('main.js', 'styles.css', 'xterm.css'):
    shutil.copy(os.path.join(MEDIA, f), tmp)
with open(os.path.join(tmp, 'index.html'), 'w') as fh:
    fh.write(PAGE)

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={'width': 320, 'height': 240}, device_scale_factor=2)
    page.goto('file://' + tmp + '/index.html')
    page.wait_for_timeout(300)

    m = page.evaluate('''() => {
      const t = document.querySelector('.tab[data-id="t2"]');
      const pill = t.querySelector('.notification-pill');
      return { pill: getComputedStyle(pill).backgroundColor, tabOpacity: getComputedStyle(t).opacity,
               role: t.getAttribute('role'), tabindex: t.tabIndex, label: t.getAttribute('aria-label') };
    }''')
    ratio = round(contrast(rgb(m['pill']), GROUND), 2)
    check('pill contrast against #1f1f1f >= 3:1', ratio >= 3, True)
    print(f'  pill {m["pill"]} → {ratio}:1')
    check('inactive tab is not dimmed as a whole', m['tabOpacity'], '1')
    check('tab role', m['role'], 'tab')
    check('tab tabindex', m['tabindex'], 0)
    check('pill has a text alternative', 'waiting' in (m['label'] or ''), True)
    page.screenshot(path=os.path.join(tmp, 'tab-bar.png'))

    page.evaluate('() => document.querySelector(".tab[data-id=t2]").focus()')
    page.keyboard.press('Shift')  # keyboard modality without moving focus
    page.wait_for_timeout(50)
    f = page.evaluate('''() => { const a = document.activeElement;
      return { label: a.getAttribute('aria-label'), fv: a.matches(':focus-visible'),
               outline: getComputedStyle(a).outlineStyle }; }''')
    check('focused tab shows :focus-visible', f['fv'], True)
    check('focus ring drawn', f['outline'], 'solid')
    page.screenshot(path=os.path.join(tmp, 'focus.png'))
    page.keyboard.press('Enter')
    page.wait_for_timeout(50)
    posted = page.evaluate('() => window.__posted.filter(m => m.type === "switchTab").map(m => m.id)')
    check('Enter on a tab posts switchTab', posted, ['t2'])
    browser.close()

print(f'screenshots: {tmp}/tab-bar.png {tmp}/focus.png')
if failures:
    print(f'\x1b[31m✗ tab-bar: {len(failures)} check(s) failed\x1b[0m')
    sys.exit(1)
print('\x1b[32m✓ tab-bar\x1b[0m')
