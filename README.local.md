# Local build

Fork of [Nolikzero/claude-terminal-panel](https://github.com/Nolikzero/claude-terminal-panel),
renamed to `local.claude-terminal-panel-local` so a Marketplace update cannot overwrite it. It
targets one machine only — there is no publish step, and there must not be one.

`CLAUDE.md` holds the rules and the architecture; this file holds everything about building,
packaging and setting the extension up. Findings and dead ends live in `LEARNINGS.md`.

## Build and install

Node 20 is required for anything that touches `vsce`:

```sh
cd ~/claude-terminal-panel
export PATH="$HOME/.nvm/versions/node/v20.19.0/bin:$PATH"
npm ci
npm run lint && npm run compile
npm run package
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --install-extension claude-terminal-panel-local-darwin-arm64-1.1.0.vsix --force
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
only (`node_modules/node-pty/lib/utils.js`), and `spawn-helper` must sit in the same directory as
the loaded `pty.node`. `.vscodeignore` keeps exactly those paths and drops everything else —
Windows prebuilds, `bin/`, sources, `deps/`, `third_party/`.

Check after any change there:

```sh
unzip -l *.vsix | grep -E "node-pty.*(\.node|spawn-helper)"
npx @vscode/vsce ls | grep -E "resources|dist/extension.js|media/main.js"
```

Expected: `build/Release/pty.node` and `build/Release/spawn-helper`, plus the same two under
`prebuilds/darwin-arm64/`, no `win32-*`, no `bin/`. And `resources/panel-statusline.js` must be
there — without it the status line silently stays hidden.

## Differences from upstream

| Area                         | Change                                                                                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status line                  | Claude's status data rendered natively at the bottom edge instead of as text in the scrollback; `claudeTerminal.statusLine` switches it off                       |
| Title bar                    | `Resume Session in Current Tab…` and `Continue Last Session in Current Tab` respawn the **active** tab with `--resume` / `--continue`, in the tab's own directory |
| Commands                     | `New Terminal Tab (Resume Session…)` and `(Continue Last Session)` do the same in an **additional** tab; Command Palette only                                     |
| Tab tooltip                  | shows the working directory, because Claude Code stores session history per directory                                                                             |
| `claudeTerminal.cwd`         | fixed working directory independent of the open folder, `~` allowed                                                                                               |
| `claudeTerminal.preloadHelp` | defaults to `false`. On, startup probes eight CLI binaries with `--help`                                                                                          |
| Help probing                 | runs without `shell: true`; command names must match `^[A-Za-z0-9._@/-]+$`                                                                                        |
| File links                   | paths outside the workspace and the terminal's cwd ask before opening                                                                                             |
| Nonce                        | `crypto.randomBytes` instead of `Math.random`                                                                                                                     |
| Build chain                  | no `@electron/rebuild`, no `node-abi`, no `postinstall`                                                                                                           |

## Status line

Model, token counts and rate limits are not in the PTY stream. Claude Code hands them only to the
configured `statusLine` command, as JSON on stdin. The source is therefore always a script, and
the extension is the reader:

1. `ptyManager` puts `CLAUDE_PANEL_TAB_ID` and `CLAUDE_PANEL_STATUS_DIR`
   (`<os.tmpdir()>/claude-terminal-panel/status`) into every PTY's environment.
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

When a tab is created, the extension sends that combination straight away. Its `updatedAt` is old,
so the row renders greyed out until the first real snapshot replaces it. The session countdown is
recomputed from `sessionResetsAt`, and if that point has already passed the session values are
dropped rather than shown stale — the window reset, so the old percentage says nothing about the
new one. `status/last/` deliberately survives a window reload; the per-tab files do not.

### Behaviour worth knowing

- The row only updates when Claude re-renders its status line. Idle, the last value stands;
  `updatedAt` older than 60 s greys the row out.
- Tabs running something other than Claude never write a file, so their row stays hidden.
- Showing or hiding the row changes the terminal height, so the webview refits xterm afterwards.
- Claude's own colours — diff blocks, highlights — are absolute truecolor sequences chosen for
  its `theme` setting. They do not follow the VS Code theme; the extension only supplies
  background, foreground and the 16 ANSI slots. On a light VS Code theme with Claude's dark
  default the result is unreadable; fix it with `/theme` inside the session.

### Troubleshooting

```sh
ls -l "$TMPDIR/claude-terminal-panel/status/"          # one file per Claude tab
ps -o command= -p <pid of the claude process>          # is --settings being passed?
```

An empty directory means the producer never ran; files present but no row means the watcher or
the webview.

## Gotchas

- **Use Node 20.** `vsce` 3.9.2 collects zero files under Node 25 and then reports
  `Extension entrypoint(s) missing`, which points at the wrong cause. `vsce ls` printing nothing
  is the tell.
- **`.vscodeignore` beats `.gitignore`.** While `.vscodeignore` exists, `vsce` ignores
  `.gitignore` entirely — measured. Anything that must stay out of the `.vsix` needs its own line
  in `.vscodeignore`.
- **Never publish.** No `vsce publish`, no Marketplace, no `VSCE_PAT`. `npm run package` builds a
  `.vsix`; installing is a separate, explicit step.
