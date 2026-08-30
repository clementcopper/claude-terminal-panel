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
  --install-extension claude-terminal-panel-local-1.1.0.vsix --force
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

| Area                         | Change                                                                                                                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status line                  | Claude's status data rendered natively at the bottom edge instead of as text in the scrollback; `claudeTerminal.statusLine` switches it off                                                                                       |
| Title bar                    | `Resume Session in Current Tab…` and `Continue Last Session in Current Tab` respawn the **active** tab with `--resume` / `--continue`, in the tab's own directory                                                                 |
| Commands                     | `New Terminal Tab (Resume Session…)` and `(Continue Last Session)` do the same in an **additional** tab; Command Palette only                                                                                                     |
| Tab tooltip                  | shows the working directory, because Claude Code stores session history per directory                                                                                                                                             |
| Engine choice                | the `+` button and `New Terminal Tab` ask **Claude Code** or **OpenCode** before spawning; each tab remembers its engine for restart/resume/continue; Claude-only session flags and the status line are skipped for OpenCode tabs |
| Editor row                   | the open file sits above the status line with its selected range; clicking it puts the **selected code** into the prompt, `@path` only when nothing is selected                                                                   |
| `claudeTerminal.cwd`         | fixed working directory independent of the open folder, `~` allowed                                                                                                                                                               |
| `claudeTerminal.preloadHelp` | defaults to `false`. On, startup probes eight CLI binaries with `--help`                                                                                                                                                          |
| Help probing                 | runs without `shell: true`; command names must match `^[A-Za-z0-9._@/-]+$`                                                                                                                                                        |
| File links                   | paths outside the workspace and the terminal's cwd ask before opening                                                                                                                                                             |
| Nonce                        | `crypto.randomBytes` instead of `Math.random`                                                                                                                                                                                     |
| Build chain                  | no `@electron/rebuild`, no `node-abi`, no `postinstall`                                                                                                                                                                           |

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

- The row only updates when Claude re-renders its status line. Idle, the last value stands;
  `updatedAt` older than 60 s greys the row out.
- Tabs running something other than Claude never write a file, so their row stays hidden.
- Showing or hiding the row changes the terminal height, so the webview refits xterm afterwards.
- The stop button leads the main row and writes Escape into the PTY. Its 36px disc is the same
  box a ring uses, so it sets the row height to a constant — one refit, not one per draw.
- Four 36px rings carry context, session limit, weekly limit and compactions. They wrap as a
  group before any of them is dropped — a ring that quietly disappeared would read as a missing
  limit rather than as a narrow panel. Measured in a headless render of the real view:

  | Panel width | Status line | Layout                                 |
  | ----------- | ----------- | -------------------------------------- |
  | ≥ 440px     | 103px       | head and all four rings on one line    |
  | 320–430px   | 147px       | rings on their own line, four in a row |
  | 236–315px   | 191px       | rings split three and one              |
  | < 236px     | 191px       | rings split two and two                |

- The context ring fills against the **threshold**, not against a full window — a full ring and
  the red are the same event. The number in its hole stays the absolute percentage. Clicking it
  asks for a new threshold (5–95) and writes `claudeTerminal.contextThreshold` for the workspace
  (globally when no folder is open). Default 60.
- The ring's arc turns yellow ten points below the threshold and red at it. Crossing it warns
  once per tab, naming the tab because the warning can come from one that is off screen; the
  warning offers to run `/clear` in that same tab. It re-arms only once the tab falls ten points
  back below the threshold, so a session sitting on the line does not warn every few seconds.
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
