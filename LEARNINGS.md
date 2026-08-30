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

## Terminal-Start im Panel

- **xterm in einem `display:none`-Element zu öffnen liefert eine 0 × 0-Messung.** Der Wrapper hat
  dann keine Box, xterm bleibt auf seinem Default 80 × 24, und alles, was vor dem ersten `fit()`
  hereinkommt, landet im falsch dimensionierten Puffer und wird danach reflowt — sichtbar als
  umgebrochene Rahmen und Fragmente. `visibility: hidden` auf einem absolut positionierten Wrapper
  hat Layout und malt trotzdem nichts; genau das macht `measureInitialDimensions` seit jeher.
- **Eine PTY darf erst starten, wenn ihr Fenster gemessen ist.** Die geschätzte Startgröße aus
  `measureInitialDimensions` lag messbar daneben, weil Statuszeile und Editor-Zeile darin fehlen:
  bei 520 × 400 px meldete sie 65 × 25, das Terminal hielt am Ende 62 × 18 — sieben Zeilen zu viel.
  Der Host wartet jetzt auf `terminalReady` aus dem Webview.
- **Die Größe muss sich erst beruhigen, bevor man sie meldet.** Zwei RAFs reichen nicht: die
  Statuszeile kommt in den Nachrichten direkt hinter `createTab` und ändert die Höhe danach. Ein
  Timer, den jeder Fit neu startet (80 ms), meldet den Wert, den das Terminal behält — im Harness
  über drei Panelgrößen identisch mit dem letzten Fit.
- **`killAll()` an `onDidDispose` des Webviews nimmt die Sitzungen mit.** Das Webview wird auch
  neu gebaut, wenn man das Panel in die andere Seitenleiste zieht. Die Prozesse laufen jetzt
  weiter, `handleReady` stellt die Tabs wieder her, und die Referenz auf das alte Webview wird
  fallen gelassen, damit kein `postMessage` mehr dorthin geht.
- **Ein Zeitfenster ist kein Ersatz für Identität.** Der Respawn unterdrückte die Exit-Meldung der
  alten PTY über ein Flag mit 100-ms-Timer. Kam das Ereignis später, stand `[Process exited with
code 129]` (128 + SIGHUP, der Kill selbst) in der frisch gestarteten Sitzung — und Restbytes der
  alten PTY gleich hinterher. `PtyManager` vergleicht jetzt in beiden Handlern die PTY-Instanz mit
  der, die für die Tab-ID eingetragen ist; alles andere ist ein bereits abgeräumter Prozess.

## OpenCode-Startzeit

- **OpenCodes Wartezeit steckt im Server, nicht im TUI — aber ein warmer Server holt sie kaum
  zurück.** Gemessen mit node-pty (62 × 18, erstes Byte / erste 1 kB Ausgabe): `opencode` pur
  braucht 1,9 s bis zum ersten Byte und **5,1–5,4 s bis zur ersten sichtbaren Ausgabe**; die ersten
  ~280 Bytes sind nur Escape-Sequenzen, der Bildschirm bleibt leer. `opencode attach <url> --dir …`
  gegen ein laufendes `opencode serve` kommt auf 4,0–4,2 s — **1,3 s Gewinn**, nicht mehr, weil der
  Rest Bun-Start plus TUI-Init ist. Dafür einen dauerhaften Hintergrundprozess samt Lebenszyklus
  und einen unauthentifizierten lokalen Agent-Endpunkt (`serve` warnt selbst:
  „OPENCODE_SERVER_PASSWORD is not set; server is unsecured") einzuhandeln, lohnt nicht. Ein
  laufender Server beschleunigt `opencode` pur übrigens **nicht** — ohne `attach` startet das TUI
  seinen eigenen.
- **Wo die Zeit hingeht, steht in OpenCodes eigenem Log** (`~/.local/share/opencode/log/opencode.log`):
  pro Lauf eine `run=`-ID, darin `creating instance`, `init count=41`, `watcher backend`,
  `booting location services`. Erst dort nachsehen, bevor man dem Panel die Schuld gibt.
- **Fünf Sekunden einfarbige Fläche sind kein Ladezustand.** Der Startanzeiger ist reines DOM im
  Terminal-Wrapper — kein Byte in die PTY, damit er den Alternate-Screen-Aufbau eines TUI nicht
  stören kann — und erscheint erst nach 250 ms, damit ein schneller Start nicht aufblitzt.

## Prüfwerkzeuge für dieses Repo

- **Das Webview lässt sich headless fahren, ohne VS Code.** Eine HTML-Seite mit den drei IDs
  (`terminals-container`, `status-line`, `tab-bar`), `media/main.js`, `styles.css`, `xterm.css`
  daneben, und ein Stub davor:
  `window.acquireVsCodeApi = () => ({ postMessage(m){ window.__posted.push(m); }, getState(){}, setState(){} })`.
  Der Stub muss **vor** `main.js` im Dokument stehen — ein `add_init_script` aus Playwright wird
  vom Inline-Skript der Seite überschrieben. Nachrichten kommen per
  `window.dispatchEvent(new MessageEvent('message', {data: …}))` hinein, alles Ausgehende steht in
  `window.__posted`. Damit sind Fit-Größen, Statuszeile, Startanzeiger und Tooltips messbar statt
  behauptbar. Playwright liegt hier **nur als Python-Paket** unter
  `/usr/local/opt/python@3.9/bin/python3.9` (`which playwright` zeigt ein Python-Skript, `npx playwright`
  findet kein Node-Modul), Browser in `~/Library/Caches/ms-playwright`.
- **Extension-Module lassen sich außerhalb des Hosts testen, wenn man `vscode` wegbündelt.**
  `npx esbuild src/x.ts --bundle --platform=node --format=cjs --alias:vscode=<stub.js> --external:node-pty`
  — der Stub braucht nur `Uri.joinPath`, `workspace.workspaceFolders/getConfiguration`,
  `window.showWarningMessage/createOutputChannel`. So wurden `rememberLimits`, `broadcastLimits`
  und die PTY-Identitätsprüfung mit gefälschten PTYs geprüft, jeweils **auch gegen `git show HEAD:`**
  gebündelt — eine Probe, die auf dem alten Stand nicht rot wird, prüft nichts.
- **`node-pty` läuft in normalem Node** (N-API), man braucht für Startzeitmessungen keinen
  Extension-Host: `require('<repo>/node_modules/node-pty')`, `spawn`, Zeitstempel auf erstes Byte
  und auf kumulierte Bytes. Zeit bis zum ersten Byte ist bei TUIs irreführend — die ersten
  Hunderte Bytes sind Escape-Sequenzen; die Schwelle „erste 1 kB" trifft den sichtbaren Aufbau.
- **Die echte View im Headless-Chrome fahren statt DOM nachzubauen.** `media/main.js` läuft
  außerhalb von VS Code, wenn man vor dem Bundle `window.acquireVsCodeApi` stubt und die drei
  Elemente `#terminal-column` / `#terminals-container` / `#status-line` bereitstellt; getrieben
  wird sie dann über `window.postMessage({type:'createTab'…})`, also über die echten
  Handler. Gemessen mit `chrome-headless-shell --dump-dom` (in
  `~/Library/Caches/ms-playwright/chromium_headless_shell-*/`), Ergebnisse als JSON in ein
  `<pre>` geschrieben und herausgegrept.
- **Die Sonde selbst zuerst nachmessen.** Ein `style.width` auf `#terminal-column` hatte keine
  Wirkung: das Element ist Flex-Item mit `flex: 1`, also `flex-basis: 0`, und das schlägt die
  Breite. Fünf Messreihen sahen dadurch identisch aus, ohne dass etwas gemeldet wurde. Erst
  `style.flex = '0 0 auto'` machte die Breite wirksam — vor jeder Messreihe die gesetzte Größe
  zurücklesen.

## Statuszeile

- **Der Statusordner in `$TMPDIR` ist maschinenweit, nicht fensterweit.** Alle VS-Code-Fenster
  desselben Nutzers teilten `claude-terminal-panel/status`; der Startaufräumer löschte dort jede
  Datei und der Aufräumer beim Schließen lief über alles, was der Watcher _gesehen_ hatte — beides
  traf lebende Tabs anderer Fenster. Der betroffene Watcher las `ENOENT` und meldete `null`, die
  Zeile fiel auf die Editor-Zeile zusammen. Reproduziert mit zwei `StatusLineWatcher` in zwei
  Prozessen und `TMPDIR` auf ein Scratch-Verzeichnis; seitdem `status/<window token>/`.
- **Eine fehlende Datei ist kein Beweis für einen toten Tab.** Nur `removeTerminal` weiß das.
  Jede andere Löschursache darf den letzten Snapshot nicht wegwerfen.
- **Ein Ordner, der aufgeräumt werden kann, braucht einen Herzschlag.** Ein Fenster mit ruhenden
  Tabs schreibt tagelang nichts; ohne regelmäßigen `utimes` auf den eigenen Ordner hält der
  nächste Start ihn für verwaist. Und ein gelöschter Ordner nimmt den `fs.watch` mit — der hängt
  am Inode, nicht am Pfad, und meldet dabei nichts.
- **Runde Kappen fressen die Lücke — die Lücke muss sie einrechnen, nicht die Kappenform weichen.**
  `stroke-linecap: round` verlängert jedes Ende um `(Strichbreite/2)/r`, bei r 16,38 und Strich
  3,24 also 5,7°; zwei Enden fressen 11,3°. Die 14°-Lücken des Compaction-Rings blieben mit 2,7°
  (0,8 px) übrig, der Ring las sich als durchgehende Bahn. Erst auf `butt` umgestellt — das bricht
  aber die Formsprache genau da, wo vier Ringe nebeneinander verglichen werden. Richtig ist, die
  Lücke auf 21° zu ziehen (Segment 86°, Starts 120/227/334): sichtbar bleiben 9,7°, und alle vier
  Ringe behalten runde Enden. Faustregel: geplante Lücke plus `2 · (Strichbreite/2)/r` in Grad.
- **Ein Ring-Füllstand braucht keine Trigonometrie.** Ein `<circle r=16.38>` mit
  `stroke-dasharray: 2πr`, `transform: rotate(120 18 18)` und
  `stroke-dashoffset = 2πr − f · (2πr · 300/360)` trägt jeden Stand des 300°-Bogens. Gerechnete
  Pfaddaten aus Figma sind dafür nicht nötig und driften an den Enden.
- **`min-width: 0` auf dem Ring-Container war das Gegenteil von Umbruch.** Mit `flex: 1;
min-width: 0` wurde die Ringreihe auf den Rest der Zeile zusammengedrückt und jeder Ring landete
  auf einer eigenen Zeile — 260px Panelbreite ergaben 235px Statuszeile. Mit einem Boden bricht der
  Block als Ganzes auf eine eigene Zeile um: 190px.
- **`min-width` schlägt `max-width`, und `overflow: hidden` verbirgt die Folge.** Ein glattes
  `min-width: 220px` ließ den Ringblock unter 236px Panelbreite 16–56px über die rechte Kante
  stehen; die Zeile hat `overflow: hidden`, also verschwand der Comp-Ring lautlos und
  `scrollWidth - clientWidth` meldete weiter 0. `min-width: min(220px, 100%)` gibt den Boden nur,
  solange Platz dafür ist. So etwas sieht man nur, wenn man die rechte Kante des Kindes gegen die
  Innenkante des Elternteils rechnet — nicht über den Scroll-Overflow.
- **Der Umbruchpunkt liegt nicht dort, wo `min-width` rechnet.** Flex bricht anhand der
  _hypothetischen_ Größe (`flex-basis: auto` = Inhaltsbreite), erst danach wird geschrumpft. Der
  Ringblock ist rund 310px breit im Inhalt, rutscht also schon bei ~440px unter den Kopf, obwohl
  Kopf + 220px + Abstände erst bei 336px nicht mehr passen. Gemessene Stufen: ≥440px eine Zeile
  (103px), 320–430px Ringe auf eigener Zeile (147px), 236–315px drei plus eins (191px), darunter
  zwei plus zwei (191px).
- **VS-Code-Tokens sind keine Kontrastgarantie — sie müssen gegen das echte Theme gerechnet
  werden.** `--vscode-disabledForeground` ist in Dark Modern `#CCCCCC` mit 50 % Alpha und
  komponiert auf dem Grund der Zeile (`tab.inactiveBackground` = `#181818`) zu **3,69:1**. In
  Light Modern liefert dasselbe Token `#616161` und 5,83:1 — der Fehler steckt also im dunklen
  Theme, obwohl die Beschwerde aus dem hellen kam. Gemessene Werte, beide Modern-Themes, Grund
  `#F8F8F8` / `#181818`:

  | Token                    | hell                 | dunkel                 |
  | ------------------------ | -------------------- | ---------------------- |
  | `foreground`             | `#3B3B3B` 10,55:1    | `#CCCCCC` 11,06:1      |
  | `descriptionForeground`  | `#3B3B3B` 10,55:1    | `#9D9D9D` 6,55:1       |
  | `disabledForeground`     | `#616161` 5,83:1     | `#CCCCCC80` **3,69:1** |
  | `editorError.foreground` | `#E51400` **4,46:1** | `#F14C4C` 4,97:1       |
  | `#fdbd00` (literal)      | **1,59:1**           | 10,53:1                |

  Die Werte kommen aus `<VS Code.app>/Contents/Resources/app/extensions/theme-defaults/themes/`
  (`light_modern.json`, `dark_modern.json`, jeweils der `include`-Kette folgen) plus den Vorgaben
  aus der Workbench-Farbregistry für Tokens, die kein Theme setzt. Achtstellige Hex-Werte tragen
  Alpha und müssen **vor** der Messung über den Grund komponiert werden.

- **Modusabhängige Farben gehören an `body.vscode-light`.** VS Code stempelt den Modus auf den
  Body des Webviews; die Klassen heißen `vscode-light`, `vscode-dark`, `vscode-high-contrast` und
  `vscode-high-contrast-light` (nachgesehen in `out/vs/workbench/contrib/webview` im App-Bundle).
  Ein Ton, der auf `#181818` trägt, trägt nicht auf `#F8F8F8`: `#fdbd00` fällt dort von 10,53:1
  auf 1,59:1.
- **Die Sonde misst die Fallbacks, nicht das Theme.** Ohne VS Code lösen `var(--vscode-…)` auf die
  CSS-Fallbacks auf, und die Kontrastzahlen stimmen dann für nichts. Die echten Token-Werte aus
  den Theme-JSONs ziehen, per `documentElement.style.setProperty` in die Sonde injizieren, die
  Modusklasse auf `body` setzen — und den Kontrast aus `getComputedStyle` gegen den gerenderten
  Hintergrund rechnen statt aus dem Quelltext abzulesen.
- **Bei manchen Farben schlägt der Farbton den Kontrast — und das ist kein Verstoß, sondern eine
  Abwägung.** Warngelb liegt bei 45°, Warnorange bei 39°; jeder Ton dieser Farbtöne, der auf
  hellem Grund 4,5:1 erreicht, ist keins von beidem mehr: `#8A6200` misst 5,17:1 und liest sich
  als Braun. Gemessene Reihe auf `#F8F8F8`: `#fdbd00` 1,59:1 · `#FDA400` 1,89:1 · `#E8A600`
  2,00:1 · `#C89000` 2,66:1 · `#B08000` 3,33:1 · `#8A6200` 5,17:1. Eine Warnfarbe, die nicht als Warnfarbe erkennbar ist, warnt vor nichts. Der
  gesättigte 3,24px-Bogen bleibt sichtbar, die kleine Zahl im selben Ton nicht — falls beides
  gebraucht wird, färbt man den Bogen und lässt die Zahl auf der Textfarbe.
- **Hierarchie aus zwei Grautönen überlebt den Moduswechsel nicht.** Der Abstand zwischen zwei
  Grautönen ist auf `#F8F8F8` ein anderer als auf `#181818` — in Light Modern fallen
  `foreground` und `descriptionForeground` sogar auf denselben Wert (`#3B3B3B`) zusammen, die
  Hierarchie verschwindet also ganz. Eine Farbe für beide Zeilen, Unterschied über das
  Schriftgewicht: das trägt in beiden Modi gleich.

## Schriften und Scrollbar im Panel

- **„SF Pro Compact" gibt es nicht.** Apples Familien heißen `SF Pro` und `SF Compact` — Geschwister,
  keine Verschachtelung —, je mit `Display`, `Text` und `Rounded` als optische Größen. Installiert
  sind sie hier über `~/Library/Fonts` und `/Library/Fonts`; `SF Mono` liegt im Bundle von
  Terminal.app (`/System/Applications/Utilities/Terminal.app/Contents/Resources/Fonts/`) und ist
  von dort systemweit registriert. Prüfen mit
  `system_profiler SPFontsDataType | grep -E "^ +Family: "`.
- **Dass ein Font im Stack steht, heißt nicht, dass er auflöst.** Im Renderer beweist es
  `document.fonts.check('12px "SF Compact Display"')` plus eine Breitenmessung über
  `canvas.measureText` gegen den Fallback: gleiche Breite = stillschweigend zurückgefallen.
  Gemessen für „Session 100% · Sun 1:00 AM" bei 12px: SF Compact Display 140,16px · SF Compact
  Text 151,3px · sans-serif 156,76px · SF Mono 192,87px · Menlo 187,84px.
- **Ein `var()` ohne eigenen Fallback reißt die ganze Deklaration mit.** `font-family: 'SF Mono',
var(--vscode-editor-font-family), Menlo` ist ungültig, sobald das Token fehlt — nicht etwa „dann
  eben Menlo", sondern gar keine Schriftfamilie. In jedem Stack gehört der Fallback in das `var()`
  selbst.
- **xterm 6 hat die nativ scrollende Viewport aufgegeben.** Statt `overflow-y: scroll` auf
  `.xterm-viewport` läuft jetzt VS Codes Scrollbar-Widget (`.xterm-scrollable-element > .scrollbar`).
  Alle `::-webkit-scrollbar`-Regeln auf der Viewport treffen damit ins Leere, ohne dass irgendetwas
  meldet. Die Sichtbarkeit steht im Bundle fest auf `ScrollbarVisibility.Auto` und ist über die
  öffentliche API nicht einstellbar; gemessen kippt die Klasse rund eine Sekunde nach dem letzten
  Scrollen von `visible scrollbar vertical` auf `invisible scrollbar vertical fade`.
- **Eine dauerhaft eingeblendete Scrollbar braucht eine Bedingung.** Ohne Scrollback zeichnet das
  Widget den Slider über die volle Trackhöhe — dauerhaft sichtbar gemacht wäre das ein grauer
  Streifen an jedem ruhenden Terminal. `buffer.active.baseY > 0` ist die Bedingung; sie als Klasse
  auf den Wrapper legen und die CSS-Regel daran hängen.
- **Ein Wrapper ist ein Flex-Element — und bricht als Ganzes um.** Die vier Ringe lagen in einem
  eigenen Container; unter ~440px rutschte der komplett in die zweite Zeile und ließ den
  Stop-Button allein in der ersten stehen. Als direkte Geschwister der Zeile brechen sie einzeln
  um, und weil ein Flex-Element nicht rückwärts umbrechen kann, hält das erste Kind in jeder
  Breite den Anfang der ersten Zeile. Wer „X bleibt vorn, der Rest fließt" will, darf zwischen X
  und den Rest keinen Container setzen.
- **„Sehe ich nicht" heißt nicht immer „ist nicht da".** Die Terminal-Scrollbar wurde die ganze
  Zeit gerendert — 6px breit, 20px hoch, Slider bei 1,67:1 gegen den Terminalgrund. Erst der
  Screenshot mit den echten Theme-Werten zeigte, dass sie existiert und trotzdem übersehen wird.
  Vor der nächsten Runde Ursachensuche also erst rendern und hinsehen, sonst repariert man etwas,
  das funktioniert.
- **Vor jeder Diagnose prüfen, ob der Nutzer überhaupt den neuen Build sieht.** Startzeit des
  Extension-Hosts gegen die mtime von `~/.vscode/extensions/<id>/media/main.js` halten; die PID
  steckt im Fenster-Token des Statusordners (`parseInt(token.split('-')[0], 36)`). Hier lief der
  Host seit 13:07:56, das Bundle war 13:05:03 installiert — der Fix war also live, und die Suche
  musste woanders weitergehen.
- **`node-pty` beantwortet Terminalfragen ohne VS Code.** Ob eine CLI den Alternate Screen nutzt —
  und damit ob `buffer.active.baseY` je über 0 geht — beweist ein Sechs-Sekunden-Spawn mit
  `grep` auf `\e[?1049h` / `?1047h` / `?47h` in den Rohbytes. Claude Code nutzt ihn nicht.
- **Ein Ersetzungsskript, das mitten in einer Kette scheitert, schreibt gar nichts.** Drei
  `assert`/`replace`-Paare in einem Python-Heredoc, das erst am Ende `write()` aufruft: schlägt
  das dritte fehl, sind auch die ersten beiden verloren, und die Ausgabe zeigt nur den einen
  Traceback. Zweimal in dieser Sitzung passiert, jedes Mal weil `prettier` die Zielzeilen vorher
  umgebrochen hatte. Vor dem Muster den Zieltext frisch auslesen (`repr()` auf die Zeilen), nicht
  aus dem Gedächtnis zitieren.
- **Einen Fokusring zu entfernen heißt `outline: none` zu schreiben, nicht die Regel zu löschen.**
  Chromium malt auf einem fokussierten `<button>` seinen eigenen Ring; nimmt man nur die eigene
  `:focus-visible`-Regel weg, kommt er lauter zurück als der entfernte. Gegenprobe: Element per
  `focus()` fokussieren und `getComputedStyle(el).outlineStyle` zurücklesen — `none` erst dann
  glauben. `focus()` allein löst in Chromium kein `:focus-visible` aus, deshalb zusätzlich `:focus`
  mitnehmen und die Regeln im Stylesheet zählen.
