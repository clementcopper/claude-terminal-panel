# Learnings, improvements & dead ends — claude-terminal-panel (local fork)

Non-obvious findings and dead ends. Only add what saves future work.

## Packaging

- **`vsce` applies negations in `.vscodeignore` after every ignore pattern**, not in line order. A
  blanket `!node_modules/node-pty/**` therefore pulls the whole module back in, whatever
  exclusions follow it. The working shape is: ignore everything, then negate exactly the paths
  that ship. Result here: 15.64 MB → 608 KB.
- **`vsce` 3.9.2 collects zero files under Node 25** and then reports
  `Extension entrypoint(s) missing`, although the bundle exists — the message points at the wrong
  cause. Node 20 works. `vsce ls` printing nothing is how to recognise it.
- **`vsce` does NOT read `.gitignore` while `.vscodeignore` exists.** Measured with vsce 3.9.2:
  with `dist/` added to `.gitignore`, `vsce ls` still listed `dist/extension.js`. An earlier note
  here claimed the opposite — it was wrong. Consequence: anything that must stay out of the
  `.vsix` needs a line in `.vscodeignore`; a `.gitignore` entry is not enough (a screenshot
  dropped into the project folder shipped that way). Conversely `.gitignore` would only take over
  if `.vscodeignore` were deleted — and then the build output would fall out of the package.
- **`vsce` matches ignore patterns case-sensitively, git does not.** `core.ignorecase` is `true` on
  this filesystem, so `.gitignore`'s `Screenshot*.png` swallows `screenshot_2.png` — while
  `.vscodeignore`'s identical line does not, and the file shipped: 1.9 MB in a 3 MB package. The
  two files look the same and behave differently; a name that git hides is not thereby out of the
  `.vsix`. Check the payload by size, not by assuming.
- **`.git/info/exclude` settles the conflict between `git status` and `vsce`.** Build output
  cannot go into `.gitignore` by convention here, but sits in the working tree as untracked noise.
  An entry in `.git/info/exclude` hides it locally only; `vsce` does not read that file. Checked:
  `vsce ls` still lists `dist/extension.js`, `media/main.js` and `media/xterm.css` afterwards.

## Native module

- **`node-pty` 1.1.0 is N-API** (`napi_register_module_v1`), so it is ABI-independent. No rebuild
  when VS Code updates, and `@electron/rebuild` plus `node-abi` are superfluous. Evidence: the
  same `pty.node` loads under Node ABI 115, 141 and 146.
- **A directly started Electron (`ELECTRON_RUN_AS_NODE=1`) cannot load foreign `.node` files**:
  "mapping process and mapped file (non-platform) have different Team IDs". Library Validation
  bites there but not in the real extension host, so that route is **not** usable for ABI tests —
  load the same file under several nvm Node versions instead. Plain JavaScript is unaffected,
  which is why the bundled status line producer runs fine that way.
- **The loader only looks in `build/Release`, `build/Debug` and `prebuilds/<platform>-<arch>`**
  (`node_modules/node-pty/lib/utils.js`) and expects `spawn-helper` **in the same directory** as
  the loaded `pty.node`. `@electron/rebuild` puts its result under
  `bin/<platform>-<arch>-<abi>/node-pty.node` instead — which is never loaded.
- **`spawn-helper` arrives without its executable bit and nothing puts it back.** `npm ci` leaves
  it at 644, `node-pty`'s own `scripts/post-install.js` only cleans `build/Release` and never
  chmods, and `vsce` stores the mode verbatim. The symptom is not a load error — `pty.node` loads
  fine and `pty.fork` dies with `Error: posix_spawnp failed`, which names neither the file nor the
  permission. Fixed at packaging time by `scripts/verify-package-payload.js`.
- **This machine is Intel** (i7-7700HQ), and VS Code 1.132.0 is the x86_64 build in
  `/Applications`. The documented `--target darwin-arm64` was therefore wrong from the start and
  produced `Cannot find module './prebuilds/darwin-x64//pty.node'`. A platform tag buys nothing
  once `@electron/rebuild` is gone: all four prebuilds are in the tarball after any `npm ci`,
  whatever the host architecture, so shipping them all is both simpler and portable.
- **`.pdb` files are ~95 % of the Windows prebuilds** — 58 MB raw for `win32-x64` plus
  `win32-arm64`, 5.1 MB without them. They are debug symbols and nothing loads them. They cannot
  be removed with a trailing ignore rule either, because negations win regardless of order, so the
  Windows files are negated one by one.
- **`vsce` 3.9.2 runs fine under Node 22.14.0** — 73 files collected. The Node 25 failure is not a
  "anything but 20" problem. That Node 22 is no longer installed here, though: as of 2026-08-11
  nvm carries `v20.19.0` and the default is `v25.8.1`, so a build has to put v20 on the `PATH`
  first. Check `ls ~/.nvm/versions/node` instead of trusting a version named in the docs.

## Claude Code

- **The extension host inherits Finder's PATH, not the login shell's.** On macOS a window launched
  from Finder/Dock is missing the user-local dirs where CLI agents live (`~/.local/bin`,
  `~/.opencode/bin`). `claude` was in `~/.local/bin` and worked, `opencode` in `~/.opencode/bin`
  failed — the asymmetry looked like an opencode bug but was a PATH gap.
- **node-pty reports a binary that is not on PATH as `[Process exited with code 1]`, silently** —
  no error text, no throw. Reproduced: spawning `opencode` with a stripped `env.PATH` exits 1 with
  empty output. The `/bin/sh`-style fallback masks "command not found" as a plain exit. Fix in
  `PtyManager.resolveCommand`: resolve the command to an absolute path across the host PATH plus
  `~/.local/bin`, `~/.opencode/bin` and `~/bin` before `spawn`, so a bare name works regardless
  of how the host was launched. This applies to every custom-command agent, not just opencode.
- **Claude Code stores session history per working directory** under `~/.claude/projects/<path>/`.
  A panel that starts in the wrong folder shows an empty `/resume` list with nothing actually
  broken. Hence the cwd in the tab tooltip and the `claudeTerminal.cwd` setting.
- **Claude's own colours do not follow the terminal theme.** Diff blocks and highlights arrive as
  absolute truecolor sequences matching Claude's `theme` setting — without an entry in
  `~/.claude/settings.json` that is the dark default. On a light VS Code theme the result is
  unreadable, and the extension cannot fix it: it only supplies background, foreground and the 16
  ANSI slots. The remedy is Claude's own theme (`/theme`); an ANSI-based variant would reuse the
  values the extension provides. There is no `COLORFGBG` in the PTY either, so Claude gets no hint
  about light or dark.
- **The statusLine command runs on session state changes, not on renders.** Measured with a
  throwaway node-pty probe that spawned `claude` with the panel's own `--settings` injection and
  watched the snapshot file: a PTY resize repaints the whole TUI — 2825 to 2908 bytes including a
  `\x1b[2J` — and still produces no run. Same for terminal focus events, Escape, Ctrl+O, opening
  and closing the slash menu, and typing a character. The one trigger found was `shift+tab`, the
  permission-mode cycle, twice at 407 and 447 ms. Two controls with no nudge at all wrote nothing,
  so those zeros are real and not a broken probe.
- **That rules out a refresh button that costs no tokens.** Cycling the permission mode to force an
  update would pass through accept-edits on the way, and a third press in the same run was not
  consumed at all, so "once around and back" cannot be relied on to end where it started. The CLI
  has no way in either: `claude --help` lists `agents`, `auth`, `doctor`, `mcp`, `plugin`,
  `project`, `setup-token`, `update` — nothing that reports usage or rate limits.
- **What actually goes stale is only the rate limits.** Token counts cannot change without a turn,
  and a turn makes Claude render anyway. The limits change through other sessions and through time,
  which is why the countdown is recomputed in the webview from the absolute `sessionResetsAt`
  rather than fetched.

## Prompt input

- **An at-mention pulls the whole file, a line range in it is only prose.**
  `@src/foo.ts (lines 264-268)` puts all of `foo.ts` into the context — measured: 7422 bytes
  arrive for 120 bytes of selection. If the point is to send _the selection_, the selection has to
  be in the text.
- **A `\n` written into the PTY submits the prompt.** Multi-line text therefore has to go in
  wrapped in the bracketed paste markers `\x1b[200~` … `\x1b[201~`, which is what a real paste
  sends; Claude Code turns the mode on (`CSI ?2004h`). Without them a five-line snippet fires five
  half-written prompts.
- **A quoted snippet needs a fence longer than anything inside it.** Selected code containing a
  markdown fence or a template literal would otherwise close the block early. Longest run of
  backticks plus one, minimum three. (Written out rather than shown: prettier reformats an inline
  triple backtick in this file into a real fence.)

## Webview

- **`xterm.css` paints the viewport `#000`** (`.xterm .xterm-viewport`, line 93 — a workaround for
  opaque macOS scrollbars). xterm colours the cells from its theme but not that surface, and
  `FitAddon` works in whole rows, so the leftover strip below the last row showed as a black band
  once the wrapper lost its padding. The override belongs in `styles.css`: `media/xterm.css` is
  copied fresh from `node_modules` on every `npm run compile`.
- **`opacity` on an element dims its children too.** A progress track with `opacity: 0.25` and a
  fill in the same colour therefore looks completely empty — the fill inherits the 25 %. Track and
  fill need their own colours instead of one colour plus opacity.
- **`direction: rtl` for a left-side ellipsis reverses plain ASCII paths**:
  `~/claude-terminal-panel` came out as `claude-terminal-panel/~`, because `/` and `~` are
  bidirectionally neutral. Shortening in code is more reliable than the CSS trick.
- **xterm themes are a snapshot, not a CSS binding.** `theme` takes finished colour values, so a
  terminal only follows a VS Code theme change if the values are handed over again. A
  `MutationObserver` on `class`/`style` of `<html>` and `<body>` is enough — VS Code rewrites the
  `--vscode-*` variables while the theme picker is merely browsed, which is why debouncing is
  needed.
- **`FitAddon` measures the parent's content box, not `clientHeight`.** addon-fit 0.11.0 reads
  `getComputedStyle(terminal.element.parentElement).getPropertyValue('height')`, whose resolved
  value excludes padding even under `box-sizing: border-box`, and subtracts only the padding of
  `terminal.element` itself. Padding on `.terminal-wrapper` therefore shrinks the terminal rather
  than clipping it — a report claiming the opposite (padding double-counted, last row cut in half)
  did not survive reading the addon source. Insets on the absolutely positioned wrapper keep the
  same air with one less thing to reason about.
- **Vertical centring needs `.xterm { height: auto }`.** Rows are whole, the wrapper's height is
  not, so `Math.floor` leaves up to one row of slack. At `height: 100%` the element fills the
  wrapper, the slack collects under the last line, and `justify-content: center` has nothing to
  centre. With `auto` the element shrinks to the rows actually laid out. `FitAddon` measures the
  wrapper, so this does not feed back into the row count. All of xterm's other children
  (`.xterm-viewport`, `.xterm-helpers`, the decoration containers) are absolutely positioned and
  contribute no height.
- **The panel's layout can be measured without VS Code.** Copy `xterm.js`, `xterm.css` and
  `addon-fit.js` out of `node_modules` into a page that repeats the wrapper rules, then drive it
  with Playwright (`/usr/local/bin/playwright` is the Python one; Chromium is already in
  `~/Library/Caches/ms-playwright`). Sweeping the viewport height one pixel at a time settled in
  minutes what a reload-and-look loop had not: the gaps above and below match to 0.00 px at every
  height, so what was left was optical, not geometric.
- **Measured symmetry is not perceived symmetry.** With both gaps provably equal the last line
  still read as sitting too low; the fix was 4 px more at the top inset and 5 px of margin below
  the container, both set by eye. Write into the comment that the numbers are deliberately uneven,
  or the next reader restores the matching values and undoes it.

## OpenCode theme in the panel

- **OpenCode derives its terminal theme mode from one colour only: `defaultBackground`.** Its
  `system` theme and its static themes all decide dark/light via `terminalMode()`, which buckets the
  OSC-11 background by luminance (Rec.601). So to make an OpenCode tab in the panel follow the
  system appearance, the lever is the background our xterm reports on an OSC-11 query — not the
  theme file. xterm answers such a query from `themeService.colors.background`
  (`CoreBrowserTerminal.ts`), which is exactly the `theme.background` the webview sets.
- **A static OpenCode theme does not live-switch on its own — it needs a poke after the new
  background is live.** `packages/tui/src/context/theme.tsx` watches the input
  `\x1b[?997;1n`/`\x1b[?997;2n` (`handleThemeNotification`), which triggers a palette re-query that
  flips `store.mode`; the static theme's variant only re-resolves once `store.mode` changes. The
  `system` theme in the PTY was no better — it re-derives the same way and flipped just as
  unreliably.
- **The poke must ride on the webview's own `themeApplied`, not on VS Code's theme event.** Kicking
  from `onDidChangeActiveColorTheme` fires before the webview's 50 ms `MutationObserver` sample has
  repainted xterm's new background, so OpenCode re-queries against the still-stale colour and flips
  the wrong way (observed: stuck dark while the system was light). Serialising — webview sends
  `themeApplied` after `applyTheme()`, host then writes `\x1b[?997;1n` into each OpenCode tab, only
  when the appearance bucket actually changed — made the flip reliable in both directions.

## Inter-agent channel

- **Ein zweiter PTY-Besitzer umgeht still die ganze env-Aufbereitung.** Die Sidecar-Schicht
  (`a476aeb`…`4091f67`) spawnte PTYs selbst statt über `PtyManager`. Damit fehlten in jedem Tab
  `--settings` mit dem gebündelten Statusline-Producer (Claude Code zeichnete daraufhin die
  Statuszeile _im Terminal_, doppelt zur Panel-Leiste), `CLAUDE_PANEL_TAB_ID`/`_STATUS_DIR` (die
  Panel-Statusbar blieb leer), `config.env`, `delete env.CI` und `directMode`. Nichts davon hat
  einen Fehler geworfen. Wer einen zweiten Spawn-Pfad einzieht, erbt die Pflicht, jede Zeile von
  `prepareSpawnOptions` nachzubauen — billiger ist, den Besitz nicht zu teilen.
- **`?.` auf einer Map-Lookup verschluckt Routing-Fehler.** `this.ptys.get(id)?.write(data)` ließ
  drei Commits lang jeden Tastendruck ins Leere laufen, ohne eine Zeile im Log. Bei einem Lookup,
  der nie fehlschlagen _darf_, gehört ein lautes `console.warn` in den Miss-Zweig.
- **Ein Broadcast-Fan-out braucht eine eigene msgId pro Empfänger.** Die Kopien kommen durch
  denselben Leser zurück; mit der msgId des Originals frisst sie die Dedup-Map als Duplikat der
  Zeile, die sie erzeugt hat. Und nur das Fenster des Senders darf auffächern — alle Fenster
  beobachten dasselbe tmp-Verzeichnis.
- **Ein append-only-JSONL-Watcher muss beim Start auf die Dateigröße springen.** Sonst ist beim
  Fensterstart der gesamte Verlauf „neu" und wird in frische Tabs gepastet.
- **`Session 0%` bei `Week 100%` ist keine kaputte Übertragung, sondern der Credit-Betrieb.**
  Ist das Wochenlimit erschöpft und laufen die Turns über Usage Credits, meldet Claude Code
  `rate_limits.five_hour.used_percentage` als 0 — das Fünf-Stunden-Bucket zählt dann nicht mehr
  mit. `panel-statusline.js` reicht die Zahl unverändert weiter, `parseSnapshot` macht aus `null`
  sauber `undefined`, und `Math.round(undefined)` wäre `NaN%`. Eine 0 kann im Panel also gar nicht
  entstehen: sie kam so an. Vor der Fehlersuche `status/<tab>.json` ansehen — Alter der Datei und
  `usedTokens` beantworten die Streaming-Frage in einem Blick.
