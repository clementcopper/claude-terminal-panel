---
paths:
  - 'media/main.ts'
  - 'media/types.ts'
  - 'media/styles.css'
---

# Webview (xterm, fit, measurement, scrollbar, theme)

Distilled from `LEARNINGS.md` § Webview, § Terminal-Start im Panel (webview side), § OpenCode theme, § OpenCode-Startzeit and § Schriften und Scrollbar. Stories are there; opacity and `xterm.css` regeneration are in `CLAUDE.md`.

## Keyboard and dimming

- **xterm takes Tab as input; the bars are keyboard-reachable only from outside the terminal.** Tabs carry `role="tab"`/`tabindex`; from inside the terminal the commands remain the way.
- **Dim the parts, never the tab.** `opacity` on `.tab` took the waiting pill to 1.74:1; `--tab-accent` plus `.tab-name` opacity keeps it at 4.61:1. Same construction as `.group-tab::after`.

## Measuring and fitting

- **Never open xterm in a `display:none` element.** It measures 0×0, stays 80×24 and reflows everything received before the first `fit()`. `visibility: hidden` on an absolutely positioned wrapper has layout and paints nothing; that is what `measureInitialDimensions` does.
- **Measure the real box, never rebuild it from constants.** A hidden `.terminal-wrapper` inside the real `#terminals-container` gives FitAddon the exact box a tab gets; the old `calc(100% - 36px)` reconstruction was three rows off and knew no insets.
- **Report the size only once it has settled.** Two RAFs are not enough, the status line arrives after `createTab` and changes the height; an 80 ms timer restarted by every fit reports the value the terminal keeps.
- **`FitAddon` measures the parent's content box, not `clientHeight`.** Padding on `.terminal-wrapper` shrinks the terminal instead of clipping it; use insets on the absolutely positioned wrapper.
- **Vertical centring needs `.xterm { height: auto }`.** Rows are whole, the wrapper is not; at `height: 100%` the slack collects under the last line and nothing centres.
- **Measured symmetry is not perceived symmetry.** With both gaps provably equal the last line still read low; top inset +4 px, bottom margin 5 px, set by eye. Say in the comment that the numbers are deliberately uneven.
- **FitAddon keeps 14 px free on the right (`overviewRuler?.width || 14`) plus up to one cell from `Math.floor`.** `.xterm-scrollable-element` as flex container with `justify-content: center` splits the overhang; padding on `.xterm` does not help, and setting `overviewRuler` switches the ruler on.

## Scrollbar and buffers

- **xterm 6 uses VS Code's scrollbar widget, not a natively scrolling viewport.** `::-webkit-scrollbar` rules on `.xterm-viewport` hit nothing; visibility is fixed to `Auto` in the bundle. DOM: `.xterm > .xterm-viewport` (vestigial) and `.xterm > .xterm-scrollable-element > (.xterm-screen, .scrollbar.*)`.
- **A permanently shown scrollbar needs `buffer.active.baseY > 0` as a wrapper class.** Without scrollback the slider fills the whole track.
- **Claude Code 2.1.291 runs on the main screen; 2.1.251 used the alternate one.** Measured 2026-10-06: no `?1049h` in the startup bytes, a SIGWINCH answers with ~2 KB (`40× \e[K`, 12 newlines), so there is scrollback, `baseY` grows, and `scrollToBottom` is no longer a no-op. Measure the version (`grep -c '\[?1049h'` on a raw node-pty capture), do not trust old notes.

## Theme

- **xterm themes are a snapshot.** Hand the values over again on theme change via a debounced `MutationObserver` on `class`/`style` of `<html>`/`<body>`; VS Code rewrites `--vscode-*` while the theme picker is merely browsed.
- **OpenCode derives dark/light from one colour: the OSC-11 background xterm reports** (`theme.background`). A static OpenCode theme flips only after the `\x1b[?997;1n` poke from the host, sent after `themeApplied`.
- **Mode-dependent colours hang on `body.vscode-light` / `vscode-dark` / `vscode-high-contrast(-light)`.** A tone that carries on `#181818` fails on `#F8F8F8` (`#fdbd00`: 10.53:1 → 1.59:1).

## Misc

- **VS Code runs its own paste command into a focused webview; `preventDefault` on Cmd+V's keydown does not stop it.** It arrives as a `paste` event (empty for a Finder copy). Capture `paste` on the terminal as well and fold requests per gesture (`requestPaste`, 300 ms).
- **A drop reaches the webview only with Shift held.** VS Code blocks iframe pointer events during every drag (`windowDidDragStart` on `dragover`) and unblocks on `shiftKey`; nothing in the extension can change that.

- **`xterm.css` paints `.xterm-viewport` `#000`.** The leftover strip below the last row shows black once the wrapper loses padding; override in `styles.css`.
- **A CSS mask is an image fetch.** `mask-image: url(...)` fails silently under `default-src 'none'` without `img-src`; the tell is a button painting a full `currentColor` rectangle (~25 % coverage instead of ~4 %).
- **`direction: rtl` for a left ellipsis reverses ASCII paths** (`claude-terminal-panel/~`); shorten in code.
- **The start indicator is DOM only, shown after 250 ms.** No byte into the PTY, or it disturbs a TUI's alternate-screen setup; five seconds of blank surface is not a loading state.
- **"X stays first, the rest flows" means no container between X and the rest.** A wrapper is one flex item and wraps as a whole; direct siblings wrap individually and the first child holds the line start.
- **Removing a focus ring means writing `outline: none`, not deleting the rule.** Chromium paints its own ring on a focused `<button>`; verify with `focus()` plus `getComputedStyle(el).outlineStyle`, and cover `:focus` as well as `:focus-visible`.
- **VS Code frames and rounds the secondary sidebar itself** (`.part.auxiliarybar` border, `.webview-overlay-content` 8px clip). A hairline on the bar's top or sides doubles that frame, an own corner radius doubles the corner; only the bottom line is ours. The group bar's `+` is `sticky` and pins right only when the groups overflow, so any edge detail goes on the bar, not the button; two adjacent hairlines read as one 2px line.
- **Report a size to the PTY once it has settled (150 ms), never per frame, and only when it changed.** Every `pty.resize` is a SIGWINCH, and Claude redraws its whole UI on each (~2 KB, 12 new lines of scrollback); a drag made 45, a maximize four in 107 ms (`308x68 → 71x10`), read as "scrolls wildly". The viewport is snapped to the bottom once at the settle, never per frame. `resize-settle.js` holds the line.
- **The output channel is on disk.** `~/Library/Application Support/Code/logs/<session>/window<N>/exthost/output_logging_*/1-Claude Terminal.log` — read a user's repro from there instead of asking for a paste.
- **Anchor the content at the bottom through a reflow, not the index.** xterm keeps `ydisp` as an index unless it equals `ybase`; mark the logical line's first row (a marker on a continuation row dies on `onDelete`), put its last row back after the fit, and scroll by the delta from the pre-fit viewport — the scrollable element lags the buffer until xterm's next refresh. Reflow probes need widths at a wrap boundary (520 ↔ 580 px for 143-char lines).
