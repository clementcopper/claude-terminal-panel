# Probes for this repo (no test suite)

Distilled from `LEARNINGS.md` § Prüfwerkzeuge für dieses Repo and the measurement bullets in § Webview and § Schriften. Loaded every session because verification here is measurement, not tests.

- **An audit agent's finding is a hypothesis until the line is read.** One of ~70 claims was false (`retainContextWhenHidden` is set); check each with `sed -n` before it enters a plan.
- **`:focus-visible` in a Playwright probe:** focus programmatically, then press a bare `Shift` — keyboard modality without moving focus. Tab from inside xterm never leaves it.
- **The webview runs headless without VS Code.** A page with `#terminal-column` / `#terminals-container` / `#status-line` / `#tab-bar`, `media/main.js`, `styles.css`, `xterm.css`, and an inline `window.acquireVsCodeApi` stub **before** `main.js` (collects `postMessage` into `window.__posted`); drive it with `window.dispatchEvent(new MessageEvent('message', {data}))` so the real handlers run, then measure fit sizes, status line, indicator.
- **`--dump-dom` delivers no `ResizeObserver`, `IntersectionObserver` or `rAF` callbacks.** Anything on those paths needs CDP: `Emulation.setDeviceMetricsOverride`, `Page.captureScreenshot` to force a frame, then `Runtime.evaluate`.
- **Measure the probe first.** `style.width` on a `flex: 1` item does nothing (`flex-basis: 0`); read the set size back before every series, or five series look identical for the wrong reason.
- **The probe measures CSS fallbacks, not the theme.** Inject real token values from the theme JSONs via `documentElement.style.setProperty`, set the mode class on `body`, compute contrast from `getComputedStyle` against the rendered ground.
- **Host modules run outside VS Code when `vscode` is aliased away.** `npx esbuild src/x.ts --bundle --platform=node --format=cjs --alias:vscode=<stub> --external:node-pty` (real PTYs) or `--alias:node-pty=<stub>` (recorded spawns); the stub needs `Uri.joinPath`, `workspace.*`, `window.showWarningMessage/createOutputChannel`, and for the provider also `window.tabGroups.activeTabGroup.activeTab`.
- **A `node-pty` stub gets bundled twice; record on `globalThis`.** Otherwise the probe sees zero spawns and the hunt goes into production code.
- **Bundle the probe against `git show HEAD:` too.** A probe that is not red on the old state proves nothing.
- **`node-pty` runs in plain Node (N-API).** Start-time and terminal questions (alternate screen: grep `\e[?1049h` in the raw bytes) need no extension host; measure "first 1 kB", not first byte, the first hundreds of bytes are escape sequences.
- **Render and look before the next round of cause hunting.** The terminal scrollbar was drawn all along, 6 px at 1.67:1; a screenshot with real theme values showed it.
- **Check the user runs the new build.** Extension-host start time against the mtime of `~/.vscode/extensions/<id>/media/main.js`; the host PID is in the window token (`parseInt(token.split('-')[0], 36)`).
- **A replacement script that fails mid-chain writes nothing.** Three assert/replace pairs with one `write()` at the end lose all three on the third failure; read the target lines fresh (`repr()`), prettier has rewrapped them before.
- **The layout is measurable without VS Code.** Copy `xterm.js`, `xterm.css`, `addon-fit.js` into a page with the wrapper rules and sweep the viewport height with Playwright (Python package at `/usr/local/opt/python@3.9/bin/python3.9`, browsers in `~/Library/Caches/ms-playwright`).
