# Local build

Fork of [Nolikzero/claude-terminal-panel](https://github.com/Nolikzero/claude-terminal-panel),
renamed to `local.claude-terminal-panel-local` so a Marketplace update cannot overwrite it. It
targets one machine only — there is no publish step, and there must not be one.

`CLAUDE.md` holds the rules and the architecture; this file holds everything about building,
packaging and setting the extension up. Findings and dead ends live in `LEARNINGS.md`.

## Build and install

`vsce` needs Node 20 or newer, but not Node 25 — see Gotchas. The default on this machine is
Node 25, so a usable version goes in front of it. VS Code sits in `/Applications`.

```sh
cd ~/claude-terminal-panel
export PATH="$HOME/.nvm/versions/node/v20.19.0/bin:$PATH"
npm ci
npm run lint && npm run compile
npm run package
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --install-extension claude-terminal-panel-local-1.2.0.vsix --force
```

`--force` matters: without it VS Code skips an install whose version is already present, which is
the normal case while iterating on one version.

Then reload the window (`Developer: Reload Window`) or restart VS Code. A manifest change —
commands, menus, settings — only takes effect after that. Note that reloading kills any Claude
session running inside the panel, since it lives in the extension's PTY.

There is **no test suite**: no test script, no framework, no `.vscode-test`. Verification is
`npm run lint && npm run compile`, optionally `npx tsc --noEmit -p tsconfig.json` and
`npx tsc --noEmit -p media/tsconfig.json`, then packaging, installing and exercising the panel by
hand.

## Package contents

`node-pty` loads its binary from `build/Release`, `build/Debug` or `prebuilds/<platform>-<arch>`
only (`node_modules/node-pty/lib/utils.js`), picking the directory from `process.arch`. The
`.vsix` therefore carries **all four** prebuilds — `darwin-x64`, `darwin-arm64`, `win32-x64`,
`win32-arm64` — and no platform tag, so one build installs on Intel and ARM alike. That costs
2.96 MB in total. Everything else is dropped: `.pdb` debug symbols, `bin/`, sources, `deps/`,
`third_party/`.

Two things break silently if they slip:

- **`spawn-helper` must sit next to the loaded `pty.node` and be executable.**
  `lib/unixTerminal.js:29` derives its path from the directory the module came from. `npm ci`
  leaves the file at 644 and `vsce` copies that mode into the archive, so the module loads and
  every spawn dies with `posix_spawnp failed`.
- **A missing prebuild only shows on the machine that needs it**, as
  `Cannot find module './prebuilds/<arch>//pty.node'`.

`scripts/verify-package-payload.js` covers both and runs automatically as `prepackage` and
`postpackage`. It restores the executable bit, refuses an incomplete prebuild set, and fails the
build if `.pdb` files were packaged. To check by hand:

```sh
node scripts/verify-package-payload.js --source
node scripts/verify-package-payload.js --vsix
unzip -Z -l *.vsix | grep spawn-helper       # both darwin entries must read -rwxr-xr-x
npx @vscode/vsce ls | grep -E "resources|dist/extension.js|media/main.js"
```

`resources/panel-statusline.js` must be in that last list — without it the status line silently
stays hidden.

### Linux

`node-pty` 1.1.0 ships **no** Linux prebuild. `scripts/prebuild.js` exits 1 there and the install
falls back to `node-gyp rebuild`, which produces `build/Release/pty.node` and
`build/Release/spawn-helper` — both already negated in `.vscodeignore`. So a `.vsix` packaged **on
Linux** supports Linux with no change to this repository, and one packaged on macOS never can:
there is nothing to bundle. A Linux binary in the archive does no harm on macOS, because
`loadNativeModule` tries `build/Release` first, catches the failure and moves on to `prebuilds/`.

## Differences from upstream

| Area                 | Change                                                                                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tab levels           | two: Claude Terminal tabs (groups) in a horizontal bar above the terminal, each holding its own terminal tabs in the vertical bar on the right. A group owns a working directory and its terminals inherit it — see below                               |
| Status line          | Claude's status data rendered natively at the bottom edge instead of as text in the scrollback; `claudeTerminal.statusLine` switches it off                                                                                                             |
| Title bar            | `Resume Session in Current Tab…` and `Continue Last Session in Current Tab` respawn the **active** tab with `--resume` / `--continue`, in the tab's own directory                                                                                       |
| Commands             | `New Terminal Tab (Resume Session…)` and `(Continue Last Session)` do the same in an **additional** tab; Command Palette only                                                                                                                           |
| Tab tooltip          | shows the working directory, because Claude Code stores session history per directory                                                                                                                                                                   |
| Engine choice        | asked once per tab group (**Claude Code** or **OpenCode**), never per terminal; a group runs one CLI and every tab in it remembers that engine for restart/resume/continue; Claude-only session flags and the status line are skipped for OpenCode tabs |
| Editor row           | the open file sits above the status line with its selected range; clicking it puts the **selected code** into the prompt, `@path` only when nothing is selected                                                                                         |
| `claudeTerminal.cwd` | fixed working directory independent of the open folder, `~` allowed                                                                                                                                                                                     |
| File links           | paths outside the workspace and the terminal's cwd ask before opening                                                                                                                                                                                   |
| Icons                | SF Symbols at SF Pro Medium instead of codicons, in the theme's own grey; regenerate with `scripts/render-icons.sh` — see below                                                                                                                         |
| Nonce                | `crypto.randomBytes` instead of `Math.random`                                                                                                                                                                                                           |
| Build chain          | no `@electron/rebuild`, no `node-abi`, no `postinstall`                                                                                                                                                                                                 |

## Tab groups

Two levels of tabs. The horizontal `#group-bar` above the terminal holds **Claude Terminal tabs**
(groups); the vertical `#tab-bar` on the right holds the **terminals of the active group**, as it
always has. Both bars are drawn by the webview rather than contributed to the VS Code title bar,
which is what lets the `+` for a new group sit beside the group tabs at all: title-bar actions are
right-aligned there, with no contribution point that would move one next to a tab. It comes behind
the tabs, like the `+` in the inner bar, and is `position: sticky` at `right: 0` so a row of groups
too wide for the panel scrolls under it instead of pushing it out of reach.

A group is **named after the last segment of its working directory** — `claude-terminal-panel`,
`figma-cli`, `designdone.de` — because that is what tells two groups apart; a filesystem root with
no last segment falls back to the CLI label. The name is **never truncated**: `.group-tab-name`
carries no `max-width` and no ellipsis, so a long folder name simply makes the bar scroll sideways,
with the `+` pinned to its right edge. The rename field grows with what is typed for the same
reason.

The CLI shows as colour instead — `#d97757` for Claude, `#9d7cd8` for OpenCode, the same two
accents the inner tabs use, on a 2px bar along the group tab's bottom edge (the inner tabs already
own the left edge). The bar is a `::after` pseudo-element fed by a
`--group-accent` custom property rather than a border, because the inactive state dims it to 0.45:
`opacity` on the tab itself would take the name and the waiting-for-input pill down with it. The
**A group runs one CLI.** The engine is chosen once, when the group is created, and the `+` in the
terminal bar opens another terminal of that same CLI without asking again — so Claude tabs only sit
in Claude groups and OpenCode tabs in OpenCode groups, and the group's name and accent describe
every terminal in it rather than just the first. The `+` tooltip names the CLI it will open.
`New Terminal (Resume Session…)` and `(Continue Last Session)` are refused in an OpenCode group,
because `--resume` / `--continue` are Claude-only flags and the resulting tab would be a Claude one.

There is no way past the rule. `New Terminal with Custom Command` used to be one — it ran whatever
was typed, so `opencode` in a Claude group produced an OpenCode tab there — and it is gone, along
with the help parser and path completion it needed. The panel supports these two CLIs and nothing
else, so a free-text command line had no remaining job. Per-tab flags go in `claudeTerminal.args`.

**Double-click a group tab to rename it.** The `.group-tab-name` span is swapped for an input in
place — Enter commits, Escape reverts, blur commits — and the host refuses an empty or unchanged
name, answering with a `groupsUpdate` either way so the bar always shows the name that actually
applies. Default names carry no number, because a number would only sit in front of the name you
are about to type.

Two details make the field survive its surroundings. `renderGroupBar` rebuilds the whole bar on
every `groupsUpdate`, and those fire for unrelated reasons (another group's terminal starting to
wait for input), so the renaming group's id and the current draft are held on the webview context
and the field is re-opened after the rebuild — after appending, since a detached element cannot
take focus. And the blur handler checks `input.isConnected`: without it, being torn out by that
same rebuild would read as a blur and commit the half-typed draft.

A group owns a working directory. Creating one asks for it exactly as opening a tab always did
(`PtyManager.selectWorkingDirectory`, a QuickPick only in a multi-root workspace); every terminal
opened in the group then starts there without asking again. That makes a group one project, which
is the unit Claude Code already works in — session history lives per directory, so `--resume` in
any tab of a group offers that group's sessions.

**Terminal ids stay globally unique across groups.** They key `PtyManager.ptys`, the status line's
`<terminalId>.json`, `MY_TAB_ID` / `CLAUDE_PANEL_TAB_ID` in the PTY env, the inter-agent presence
file and the webview's `#terminal-<id>`. Because they never collide, no per-tab message carries a
group id and none of those contracts had to learn about grouping; `groupsUpdate` is the only new
message going out, `newGroup` / `closeGroup` / `switchGroup` the only ones coming back.

Switching groups tears nothing down. `switchToTerminal` already hides every wrapper but one, so the
inactive groups' xterm instances and their scrollback simply stay hidden and survive.

### Behaviour worth knowing

- The last group cannot be closed and renders without a close button; closing a group's last
  terminal closes the group with it, unless it is the only one — then a fresh terminal opens in
  the same directory.
- `Cmd+Alt+Left/Right` cycle terminals **within** the active group, so the shortcut can never land
  in another working directory. `Cmd+Alt+Up/Down` cycle groups.
- A terminal waiting for input in a group that is off screen shows its pill on the **group** tab —
  otherwise that notification would have nowhere to appear.
- The group **shape** survives a window reload; the processes do not. See "Remembering the
  layout" below.
- The group bar has a fixed 28px height and is in the document from the first paint, even while
  empty, so it is part of the box `measureInitialDimensions` measures rather than a later height
  change the PTY would never hear about.

### Remembering the layout

The groups are written to `context.workspaceState` under `claudeTerminal.layout` — workspace scope,
not global, because groups carry working directories and those belong to a project. Saved on
structural change only (create, close, rename, switch), never from `sendGroupsUpdate`, which also
fires whenever a tab starts or stops waiting for input and would turn a prompt flicker into a disk
write.

The record is index-based and free of ids, since ids are minted per run: per group the name, cwd,
engine, workspace folder index, tab count and which tab was on screen, plus which group was active.
It is read back as `unknown` and narrowed field by field — it comes off disk, where an older shape
of the extension or a hand edit could have left anything — with the tab count clamped to 16 so a
corrupt entry cannot open hundreds of terminals, and groups whose directory no longer exists
dropped.

**Restored tabs are cold.** The extension host dies with the window, so the processes are gone and
there is no scrollback or session to bring back; what returns is the shape. Starting a CLI per
restored tab would cost a Claude session per tab on every reload, and those count against the
account's limits — so a restored tab exists in the bar with no process, and starts the first time
it is switched to. Only the one tab that was on screen starts immediately, because switching to it
is exactly what the restore does last.

Waking one goes through the normal measurement path rather than spawning straight away. The webview
sends `terminalReady` once per tab and a cold tab has already spent that report, so the host sends
`startTerminal`, the webview clears `readySent`, re-fits and reports again — which is what the host
was waiting for. That keeps the rule the whole startup path exists for: a process learns its window
size before it paints its first frame. `handleTerminalReady` and `handleResize` both ignore a cold
tab; without that, every reload would log `resize of unknown terminal` once per restored tab and
train you to ignore the one warning that matters.

A **webview** rebuild is a different thing entirely and needs none of this: moving the panel to the
other sidebar or running `Developer: Reload Webviews` leaves the extension host and its PTYs alive,
and `handleReady` finds the tabs still in the state manager and recreates their wrappers. The
scrollback is not replayed — the host forwards PTY output and keeps no copy — so a rebuilt webview
starts every tab empty while the processes carry on. Collapsing the view does not rebuild it
(`retainContextWhenHidden`), so the common case keeps its history.

## Icons

Every icon the fork contributes is an **SF Symbol at SF Pro Medium**, rendered from macOS by
`scripts/render-icons.sh` into `media/icons/`. Regenerating them needs the Swift command line
tools; the script is the only reason those PNGs are reproducible rather than mystery binaries.

| Slot                  | Symbol                   |
| --------------------- | ------------------------ |
| Resume Session        | `clock.arrow.circlepath` |
| Continue Last Session | `forward.frame`          |
| Restart Terminal      | `arrow.clockwise`        |
| View container        | `viewfinder`             |
| Webview `+`           | `plus`                   |
| Webview `×`           | `xmark`                  |

**They are PNGs, not SVGs.** AppKit rasterises a symbol when it draws it — a PDF exported from
`NSImage.draw` contains `/Im1 Do`, an image, with no paths to lift out. They are therefore rendered
at 3x (36pt on a 48×48 canvas) and scaled into VS Code's 16px box. The common square canvas
matters: the symbols have different natural aspect ratios, and without it VS Code would scale each
to a different apparent size.

**Availability follows the OS, not the SF Symbols app.** A name introduced in a later release fails
with `SYMBOL NOT FOUND` even though the app lists it — `clock.arrow.trianglehead.counterclockwise.rotate.90`
does exactly that on macOS 13. Check a new name by running the script before wiring it in.

**Colour.** The three title-bar actions ship a light/dark pair, and VS Code picks by theme type —
so the file named `light` carries the _dark_ grey `#3B3B3B`, the one named `dark` carries
`#CCCCCC`. The view container contributes a single path with no pair, so it uses one balanced grey:
`#797979` measures 4.10:1 on Light Modern's `#F8F8F8` and 4.08:1 on Dark Modern's `#181818`, where
a single `#3B3B3B` would fall to 1.59:1 on dark.

The webview's two buttons carry no colour at all. They are applied as CSS `mask-image` over
`background-color: currentColor`, so one file follows the theme the way a codicon does — which is
also why the webview's CSP had to gain an `img-src`: a mask is an image fetch, and the policy
starts at `default-src 'none'`.

### Why not codicons

The three title-bar actions were codicons and could not be made consistent. VS Code colours the
debug ones globally, through a theming participant that builds its selector with
`ThemeIcon.asCSSSelector` at runtime — which is why the class name appears nowhere in the shipped
bundle, and why `$(debug-continue)` renders blue (`#007ACC` light / `#75BEFF` dark) and
`$(debug-restart)` green (`#388A34` / `#89D185`) even in a view title bar. `$(history)` had no such
colour and fell through to `icon.foreground`, black-ish at `#3B3B3B` in Light Modern.

It was also the lightest of the three. Measured at 16px as summed alpha coverage: `history` 49.4,
`debug-continue` 60.7, `debug-restart` 60.3. Nothing in the coloured debug family combined a
distinct shape, a matching weight and a defensible meaning — `debug-reverse-continue` matched the
weight at 61.7 but is a mirrored Continue, and `debug-step-back` looks distinct but drops to 47.6.
SF Symbols have the weight axis that the codicon set does not.

## Status line

Model, token counts and rate limits are not in the PTY stream. Claude Code hands them only to the
configured `statusLine` command, as JSON on stdin. The source is therefore always a script, and
the extension is the reader:

1. `ptyManager` puts `CLAUDE_PANEL_TAB_ID` and `CLAUDE_PANEL_STATUS_DIR`
   (`<os.tmpdir()>/claude-terminal-panel/status/<window token>`) into every PTY's environment.
2. The producer writes `<tab id>.json` there — its own flat schema, mode 600, atomically through
   a temp file plus rename — and prints nothing.
3. `statusLineWatcher.ts` watches that directory and turns each write into a `statusLine` message
   for the webview, which draws the row.

### Providers

`claudeTerminal.statusLineProvider` decides who supplies the producer:

| Value               | Behaviour                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bundled` (default) | The extension appends `--settings` with `resources/panel-statusline.js` at spawn time. Works with no setup; `~/.claude/settings.json` is never modified. An existing `statusLine` command is passed along as `CLAUDE_PANEL_DELEGATE` and run afterwards with the same stdin but without the `CLAUDE_PANEL_*` variables — its side effects survive, its text output is dropped |
| `own`               | Environment variables only. Your own script has to detect `CLAUDE_PANEL_TAB_ID` and write the file. That is the arrangement on this machine: `~/.claude/statusline-command.sh`, backup next to it as `.bak`                                                                                                                                                                   |

The bundled producer runs under VS Code's own Electron binary (`ELECTRON_RUN_AS_NODE=1`), so
neither `node` nor `jq` has to be on `PATH`. That prefix belongs in the command string, never in
the PTY environment — otherwise every Electron app started from that terminal inherits it.
`--settings` is only added when the command's basename is `claude`, so `gemini` and `aider` never
see an unknown flag.

`claudeTerminal.statusLineCompactBudget` sets the target behind the compaction counter
(`Compacted 1/3`); `0` shows the count alone.

### Writing your own producer

With `statusLineProvider: "own"`, write this shape to
`$CLAUDE_PANEL_STATUS_DIR/$CLAUDE_PANEL_TAB_ID.json`:

```json
{
  "model": "Opus 5",
  "effort": "high · fast",
  "cwd": "~/project",
  "usedTokens": 254321,
  "totalTokens": 1000000,
  "usedPercent": 25.4,
  "sessionPercent": 70,
  "sessionResetsAt": 1785940000,
  "sessionResetsInMin": 84,
  "weekPercent": 55,
  "weekResetsAt": "Fri 8:00 PM",
  "compacted": 1,
  "compactBudget": 3,
  "compactAuto": 0,
  "updatedAt": 1785941594
}
```

Only `usedTokens`, `totalTokens` and `usedPercent` are required; anything else may be `null` and
is then left out of the row. Write atomically — the watcher must never see a half-written file.
Print nothing when the panel variables are set, or the line shows up twice.

Write `sessionResetsAt` (Unix seconds) as well as `sessionResetsInMin`: the absolute point is what
survives being remembered, and the minutes are recomputed from it at render time.

### Before the first render

Claude Code only runs the statusLine command when it renders its own status line, which happens
after its first output — so a fresh tab has no data for a while. The watcher therefore keeps what
it last saw, under `status/last/`:

| File                 | Contents                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `<sha1 of cwd>.json` | the last full snapshot for that working directory — model, context, everything                                                       |
| `limits.json`        | session and weekly rate limits, which belong to the account rather than a directory, so a first tab in a new folder still shows them |

`limits.json` is a running channel between tabs, not just a starting value. A tab whose Claude is
idle can show a percentage another tab has already superseded: the number exists only in Claude's
payload, so unlike the countdown it cannot be recomputed from the clock. The watcher therefore also
watches `last/` and polls it every 30 s, and hands newer limits to every tab whose own snapshot
predates them. The tab's `updatedAt` stays as it was — model and context really are old, and the
limits row is exempt from the stale dimming anyway.

`limits.json` also fills in live snapshots, not just the initial one: Claude Code leaves
`rate_limits` out of its payload until the session has made a request, so the first snapshots
carry no Session and Week at all. Only fields the snapshot lacks are filled — a live value always
wins over a remembered one.

When a tab is created, the extension sends that combination straight away. Its `updatedAt` is old,
so the row renders greyed out until the first real snapshot replaces it. The session countdown is
recomputed from `sessionResetsAt`, and if that point has already passed the session values are
dropped rather than shown stale — the window reset, so the old percentage says nothing about the
new one. `status/last/` deliberately survives a window reload; the per-tab files do not.

### One directory per window

The per-tab files live in `status/<window token>/`, one directory per extension host, while
`status/last/` stays at the root because sharing it between windows is the point.

They used to share a flat directory, and both cleanups walked it: the one at startup deleted every
file it found, and the one at shutdown walked everything the watcher had _seen_ — which on a shared
directory includes other windows' tabs. Either way a live tab in another window lost its file, the
watcher there read `ENOENT` and reported `null`, and the row collapsed to just the editor line
until Claude next rendered. For an idle tab that is never. Both directions were reproduced against
the real module before this changed.

Two things keep it honest now: a missing file no longer clears a tab the watcher still knows about
(only `removeTerminal` does that), and a window directory is only pruned as abandoned after a day
without a stamp — the same 30 s interval that polls the limits touches its own directory, so a live
but idle window is never mistaken for a dead one. Removing it would take the `fs.watch` with it,
silently, because the watch follows the inode rather than the path.

### Behaviour worth knowing

- **Cancelling the session picker no longer kills the tab.** `claude --resume` ends with exit code
  1 when the list is dismissed with Escape (measured against the real CLI in a PTY), and by then
  the session the tab was running is gone — the resume killed it to make room for the picker. The
  tab therefore carries a recovery plan: on exit code 1 it comes back with `--continue`, the newest
  session of its own directory, which is the one that was running. If that fails too — an empty
  directory answers `No conversation found to continue`, also code 1 — it starts a plain session.
  A tab opened by `New Terminal Tab (Resume Session…)` has no previous session, so its plan is the
  plain start alone. Each step is consumed once, so the third exit prints the familiar
  `[Process exited with code 1]` instead of restarting again; `Restart` and `Continue` drop a
  pending plan, and so does an exit with any other code. Driven end to end against the real
  provider with `vscode` and `node-pty` stubbed out: resume → `--continue` → plain → message, plus
  a plain tab exiting 1 and a resumed tab exiting 0, neither of which respawns.

- The row only updates when Claude re-renders its status line. Idle, the last value stands;
  `updatedAt` older than 60 s greys the row out.
- Tabs running something other than Claude never write a file, so their row stays hidden.
- Showing or hiding the row changes the terminal height, so the webview refits xterm afterwards.
- The stop button leads the main row and writes Escape into the PTY. Its 36px disc is the same
  box a ring uses, so it sets the row height to a constant — one refit, not one per draw.
- Four 36px rings carry context, session limit, weekly limit and compactions. They wrap as a
  group before any of them is dropped — a ring that quietly disappeared would read as a missing
  limit rather than as a narrow panel. Measured in a headless render of the real view:

  | Panel width | Status line | Main row                                          |
  | ----------- | ----------- | ------------------------------------------------- |
  | ≥ 439px     | 103px       | one line: stop, model, all four rings             |
  | 253–438px   | 147px       | two lines, the split moving right as it narrows   |
  | 191–252px   | 191px       | three lines, stop and model still sharing the top |
  | 177–190px   | 191px       | three lines, stop and model alone on the first    |
  | < 177px     | 235px       | four lines                                        |

  The main row is one flat sequence — stop button, model, then a ring group per item — so the
  rings wrap one at a time instead of dropping as a block. The stop button is first in the DOM
  and a flex item cannot wrap backwards, so it holds the head of the first line at every width.

  The steps move with the UI font: they were 20–40px wider before SF Compact Display, which is
  about 10% narrower than a default sans at the same size. Re-measure after any font change.

  They were also measured with the effort badge in its long form, `HIGH · FAST`, which is about
  50px wider than the plain `HIGH` the badge shows without fast mode. These are therefore the
  widths at which the layout is guaranteed to fit; with the short badge each step arrives a
  little later. Re-measuring with `HIGH` will produce smaller numbers — that is not a regression.

- **The main row centres once it fits on one line**, and the leftover width then splits evenly on
  both sides — the design's 500px frame, where the two margins measure 51px each. The file row and
  the working-directory row keep the left edge, in the frame as well as here. The condition is
  measured, not a breakpoint: `StatusLineView.updateCentering()` compares the `offsetTop` of the
  row's items and only sets `.centered` when they all share one, so the trigger moves with the UI
  font and with the length of the effort badge instead of drifting away from a hard-coded width.
  A panel of 400px or less stays left-aligned whatever fits — a snapshot carrying a single ring
  fits on one line in a narrow panel too, and centring it there is not what the design shows. A
  `ResizeObserver` on the status line runs the same check after a resize, because a resize alone
  never rebuilds the row; `justify-content` changes neither the wrap nor the height, so it cannot
  feed itself. Measured over CDP in the headless harness, driving real resizes: 300px three lines
  left, 380/400/401px two lines left, 600px one line with 41.53px on each side, 700px 91.53px,
  800px 141.53px, and the row heights unchanged from the table above at every step.

- The context ring fills against the **threshold**, not against a full window, and so does the
  number in its hole: 32% of the window against a
  threshold of 60 reads as `53%`. It is not capped at 100, because past the threshold the ring
  can only stand full and how far past is the part worth knowing. The absolute percentage and
  the token counts are in the tooltip. Clicking the ring asks for a new threshold (5–95) and
  writes `claudeTerminal.contextThreshold` for the workspace (globally when no folder is open).
  Default 60.
- The row's three controls — the context ring, the stop button and the open-file row — draw no
  focus indicator. That is a deliberate call, and the stylesheet has to say it: deleting the rules
  would only hand the ring back to Chromium, which draws its own on a focused button. They stay
  real buttons with their `aria-label`s, so focus order and screen readers are unchanged; only
  the visible ring is gone. Keyboard focus is therefore invisible in this row.
- The Session ring's label reads `Credits` rather than `Sess` once the five-hour bucket is spent
  (100%): the turns still going through are billed to usage credits, and the remaining time stays
  in the line below it.
- **Blue to 60% of the fill, orange from there, red from 80%.** The level comes off how full the
  ring is, not off the raw percentage. Session and Week fill against 100, so those are the
  numbers on their faces; Session is red from 100% whatever the arithmetic says, because past the
  bucket the ring can only stand full. The context ring fills against the **threshold**, so its
  fractions are fractions of that budget — at the default 60 it turns orange at 36% of the window
  and red at 48%. The compaction ring is the exception: it counts rather than fills, one segment
  normal, the second orange, the third red, whatever budget sits behind it — a fraction would
  move that line with the budget, and the count is the number being judged. Two helpers,
  `StatusLineView.ringLevel` and `segmentLevel`, so the arc and the number in its hole can never
  disagree.
  Only the ring fill is
  set per theme kind off `body.vscode-light` — a blue that carries on Dark Modern's `#181818` is
  not the one that carries on Light Modern's `#F8F8F8`; the orange and the red are single values.
- Contrast is measured, not assumed. Every neutral text colour in the row clears 4.5:1 against
  its own ground in both theme kinds, and every coloured arc clears 3:1 — with three deliberate
  exceptions. The ring track sits below it the way a progress trough does, since the number
  inside each ring carries the value. The warning orange `#FDA400` measures 1.89:1 on a light
  ground: at that hue every tone reaching 4.5:1 has stopped being orange (the yellow it replaced
  had to go to `#8A6200` to get there, which reads brown), and a warning colour that is not
  recognisably a warning colour warns about nothing. And the danger red `#EC1500` measures 4.23:1
  light and 3.95:1 dark — one red for both theme kinds, chosen for the hue over the ratio, and
  also the stop button's hover fill so the row carries a single danger colour rather than two.
- The two lines beside each ring share one colour and separate by weight — 600 for the name, 400
  for the value. A hierarchy built on two greys does not survive the move between light and dark,
  because the distance between two greys is not the same on `#F8F8F8` as on `#181818`.
- Crossing the threshold warns
  once per tab, naming the tab because the warning can come from one that is off screen; the
  warning offers to run `/clear` in that same tab. It re-arms only once the tab falls ten points
  back below the threshold, so a session sitting on the line does not warn every few seconds.
- Two font stacks, both declared at the top of `media/styles.css`. The terminal gets
  `--panel-mono-font` (SF Mono first), everything else `--panel-ui-font` (SF Compact Display
  first); each falls through to VS Code's own token, so a machine without the SF fonts still gets
  the editor's. `ThemeBuilder.getFontFamily()` reads the mono variable off `documentElement`
  rather than keeping its own copy, and the two path rows — the open file and the working
  directory — take the mono stack too. Apple's family is **SF Compact**, not "SF Pro Compact" — SF Pro and SF Compact are
  siblings.
- The terminal's scrollbar is xterm 6's port of VS Code's scrollbar widget, not a native one.
  xterm hard-codes it to "auto" visibility, so it fades out about a second after the last scroll;
  `.terminal-wrapper.has-scrollback` pins it back on, and `ScrollManager.markScrollback` sets
  that class from `buffer.active.baseY`. The class is what keeps an idle terminal from showing a
  full-height grey strip: with nothing to scroll the widget still draws a slider, and it fills
  the whole track. The slider is 10px wide and mixed from the theme's own foreground — 45% of it
  in dark, 60% in light, which is what clears the 3:1 WCAG asks of a graphic element (3.19:1 and
  3.50:1). VS Code's `scrollbarSlider.*` tokens go into the xterm theme as the baseline, but they
  are tuned for a bar that only appears on hover and measure 1.67:1 and 1.80:1 against the
  terminal ground — at 6px and that colour the bar was rendering and still went unnoticed twice.
- Claude's own colours — diff blocks, highlights — are absolute truecolor sequences chosen for
  its `theme` setting. They do not follow the VS Code theme; the extension only supplies
  background, foreground and the 16 ANSI slots. On a light VS Code theme with Claude's dark
  default the result is unreadable; fix it with `/theme` inside the session.

### Troubleshooting

```sh
ls -l "$TMPDIR/claude-terminal-panel/status/"*/        # one file per Claude tab, per window
ps -o command= -p <pid of the claude process>          # is --settings being passed?
```

An empty directory means the producer never ran; files present but no row means the watcher or
the webview.

## Editor context

The row above the status line, and the reference command behind it (`src/editorContextTracker.ts`).

### Two sources, because each answers half the question

`vscode.window.activeTextEditor` is the only thing that knows about a selection, but it covers text
editors alone — open an image, a PDF or any other custom editor and it is simply `undefined`.
`window.tabGroups` sees every kind of editor but has no notion of a cursor. So the active tab
decides **which** file, and the text editor contributes the lines when it happens to be showing
that same file. Only `file:` URIs: the output panel and the SCM views are tabs too.

The tab API needs its own listeners (`onDidChangeTabs`, `onDidChangeTabGroups`) — a non-text editor
never fires `onDidChangeActiveTextEditor`.

### What goes into the prompt

A selection becomes the selected code, fenced, headed by `path:lines`. Without a selection it is an
at-mention, `@path`. The at-mention pulls the **whole file** and any line range next to it is only
prose for the model to read — measured on a 270-line file, 7422 bytes for 120 bytes of selection.
Above `MAX_SNIPPET_CHARS` (8000) the mention wins anyway, being smaller and more readable than the
block.

Two traps live here:

- **A `\n` written into the PTY submits the prompt.** Multi-line text has to go in wrapped in the
  bracketed paste markers `\x1b[200~` … `\x1b[201~` — what a real paste sends, and Claude Code turns
  the mode on. Without them a five-line snippet fires five half-written prompts.
- **The fence must outlast anything inside it**: longest run of backticks in the selection plus one,
  minimum three, or a template literal ends the block early.

The caret follows the text (`view.show(false)` plus a `focusTerminal` message, because showing the
view only gets as far as the webview and xterm listens on its own textarea). Nothing is ever
submitted.

### Why Claude Code's own IDE channel is not used

The official `anthropic.claude-code` extension runs an MCP server over WebSocket on `127.0.0.1`,
writes `~/.claude/ide/<port>.lock` (`{pid, workspaceFolders, ideName, transport, authToken}`, mode 0600) and injects `CLAUDE_CODE_SSE_PORT` through `environmentVariableCollection`. It serves
`getCurrentSelection`, `getOpenEditors`, `openDiff` and pushes `selection_changed`.

That variable only reaches terminals VS Code creates — this panel spawns its PTY through `node-pty`
directly, so it never arrives. Reading the lock file and passing the port through would work, but it
was deliberately not done: it makes the panel depend on another extension's undocumented internals,
and it would hand Claude the file and selection on every turn, for context it can read on request.
Do not "fix" this by wiring it up without asking.

## Gotchas

- **Avoid Node 25.** `vsce` 3.9.2 collects zero files there and then reports
  `Extension entrypoint(s) missing`, which points at the wrong cause. `vsce ls` printing nothing
  is the tell. Node 20 and 22 both work; the earlier instruction to pin exactly 20 was too narrow,
  and that nvm install no longer exists on this machine.
- **`.vscodeignore` beats `.gitignore`.** While `.vscodeignore` exists, `vsce` ignores
  `.gitignore` entirely — measured. Anything that must stay out of the `.vsix` needs its own line
  in `.vscodeignore`.
- **Never publish.** No `vsce publish`, no Marketplace, no `VSCE_PAT`. `npm run package` builds a
  `.vsix`; installing is a separate, explicit step.
