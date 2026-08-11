# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A local fork of [Nolikzero/claude-terminal-panel](https://github.com/Nolikzero/claude-terminal-panel),
a VS Code extension that runs Claude Code in a PTY inside the secondary sidebar. It is built and
installed **only on this machine** as `local.claude-terminal-panel-local`; the Marketplace version
is uninstalled. Renamed on purpose so a Marketplace update cannot overwrite it.

| File              | Contents                                                                            |
| ----------------- | ----------------------------------------------------------------------------------- |
| `README.local.md` | build recipe, package contents, differences from upstream, the status line contract |
| `LEARNINGS.md`    | tool quirks and dead ends — add findings there, not here                            |
| `CHANGELOG.md`    | upstream's history plus this fork's `1.1.0` entry                                   |
| `README.md`       | upstream's readme, extended with the features this fork adds                        |

## Commands

`vsce` needs Node 20 or newer, but **not** Node 25 — it collects zero files there, see
`LEARNINGS.md`. The default on this machine is Node 25, so put a usable one in front of it first:

```sh
export PATH="$HOME/.nvm/versions/node/v20.19.0/bin:$PATH"
```

| Task                     | Command                                                                       |
| ------------------------ | ----------------------------------------------------------------------------- |
| Install                  | `npm ci`                                                                      |
| Full build               | `npm run compile` (extension bundle + `media/main.js` + copies `xterm.css`)   |
| Extension only, watching | `npm run watch`                                                               |
| Lint                     | `npm run lint` / `npm run lint:fix`                                           |
| Format                   | `npm run format` / `npm run format:check`                                     |
| Package `.vsix`          | `npm run package` (no `--target`, `--skip-license`; guarded on both sides)    |
| Check the payload alone  | `node scripts/verify-package-payload.js --source` / `--vsix`                  |
| Install the build        | `code --install-extension claude-terminal-panel-local-<version>.vsix --force` |

VS Code lives in **`/Applications`** on this machine — the CLI is
`"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"`. (`~/Applications` holds
only the Claude Code URL Handler.) Check with `ls -d /Applications/"Visual Studio Code.app"`
rather than trusting this line; it has been wrong before.

The `.vsix` carries no platform tag and ships the prebuilds for `darwin-x64`, `darwin-arm64`,
`win32-x64` and `win32-arm64`, so one build installs on Intel and ARM alike. `scripts/verify-package-payload.js`
runs as `prepackage` and `postpackage`: it restores the executable bit on every `spawn-helper` and
refuses to let a package through that is missing a prebuild or carries `.pdb` debug symbols.
Linux has no prebuild in `node-pty` 1.1.0 and would have to be packaged on Linux — see
`README.local.md`.

**There is no test suite** — no test script, no framework, no `.vscode-test`. Verification is
`npm run lint && npm run compile`, then package, install, reload the window and exercise the panel
by hand. Never claim a change works without that reload. Reloading also kills the Claude session
running in the panel, so commit first.

Type-checking happens through esbuild bundling only (`tsc` is not in the build chain); run
`npx tsc --noEmit -p tsconfig.json` and `npx tsc --noEmit -p media/tsconfig.json` when a change
touches types.

## Git — read before running anything

- **Check the remote URLs, not the names** (`git remote -v`). Two versions of this file have now
  described this backwards, so verify before pushing. As of 2026-08-11: **`origin` is
  Nolikzero's** (`https://github.com/Nolikzero/claude-terminal-panel.git`) and **`fork` is ours**
  (`git@github.com:clementcopper/claude-terminal-panel.git`); `main` tracks `fork/main`. There is
  no remote called `upstream`.
- **Never push to Nolikzero's repository**, under whatever name it carries. There is no write
  access and it is not ours. Fetch from it to compare or merge. Push to ours only when asked.
- **Never create a `v*` tag.** `.github/workflows/release.yml` is upstream's, still runs
  `@electron/rebuild` and ends in `vsce publish` with `VSCE_PAT`. It has no business running for
  this fork.
- **The clone is shallow** (`--depth 1`). Before comparing against upstream or reading history,
  run `git fetch --unshallow`.
- **`git add -A` is unsafe here.** `dist/`, `media/main.js` and `media/xterm.css` are build output
  that must not be committed but also must not enter `.gitignore`; they are hidden through
  `.git/info/exclude`, which does not stop an explicit `add`.
- Unlike the quartz fork, **upstream is a live repository** — merges are realistic here. Keep
  changes small and localized, prefer additive edits over restructuring.

## Architecture

Two separately bundled halves that only talk through `postMessage`.

**Extension host** (`src/`, bundled to `dist/extension.js`, CJS, `vscode` and `node-pty`
external). `extension.ts` registers the webview provider plus every command and forwards them to
the single `ClaudeTerminalViewProvider`. That class is the hub: it implements both
`vscode.WebviewViewProvider` and `MessageHandlerContext`, and delegates everything else.

**Webview** (`media/main.ts`, bundled to `media/main.js`, IIFE, browser platform, own
`media/tsconfig.json` for DOM libs). `WebviewContext` owns one xterm.js `Terminal` per tab, the
tab bar DOM, `FitAddon` resizing, `FileLinkProvider` (clickable `path:line:col`) and
`StatusLineView`. Loaded from generated HTML with a strict CSP and a per-load nonce.

Message flow: webview `postMessage` → `onDidReceiveMessage` → `dispatchMessage`
(`src/messageHandlers.ts`, a typed handler map keyed by message `type`, exhaustive by
construction) → a `handle*` method on the provider. Return traffic goes through the provider's
private `postMessage` and a mirror handler map in `media/main.ts`.

**Message contracts are duplicated on purpose.** `src/types.ts` (`WebviewMessage`,
`ExtensionMessage`, `TabInfo`, `StatusLineSnapshot`) and `media/types.ts`
(`WebviewOutgoingMessage`, `WebviewIncomingMessage`, `TabInfo`, `StatusLineSnapshot`) are separate
declarations of the same shapes — the two bundles share no module. Adding a message means editing
both, plus `messageHandlers.ts` and the webview's map in `media/main.ts`. Both maps are keyed off
their message union, so a missing entry fails the build rather than dropping the message.

Supporting modules, each owning one concern:

| Module                                     | Role                                                                                                                                                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ptyManager.ts`                            | spawns/kills PTYs, resolves the cwd, builds the env, injects the status line settings, lazily `require`s `node-pty`                                                                                                                  |
| `terminalStateManager.ts`                  | the tab model — instances, active id, names, accent colors, `TabInfo` for the UI                                                                                                                                                     |
| `configManager.ts`                         | cached `claudeTerminal.*` settings, invalidated on config change                                                                                                                                                                     |
| `promptDetector.ts`                        | strips ANSI, buffers output, matches prompt patterns after a delay to flag "waiting for input"                                                                                                                                       |
| `commandInputPicker.ts`                    | the "new tab with command" QuickPick, with flag and path completion                                                                                                                                                                  |
| `helpExecutor.ts` + `commandHelpParser.ts` | run `<cmd> --help` and parse it (GNU → argparse → fallback parser chain) into `CommandFlag`s                                                                                                                                         |
| `pathAutocompleteProvider.ts`              | debounced, cached directory listings for flag values                                                                                                                                                                                 |
| `statusLineWatcher.ts`                     | watches `<tmpdir>/claude-terminal-panel/status/<tab id>.json`, turns each write into a `statusLine` message, and remembers the last snapshot per cwd plus the account's rate limits under `status/last/` so a fresh tab is not empty |
| `editorContextTracker.ts`                  | reports the open file and its selected lines, from `activeTextEditor` plus the tab API, and formats what the reference command puts into the prompt — see `README.local.md`                                                          |
| `resources/panel-statusline.js`            | shipped status line producer, run by Claude Code, not by the extension host                                                                                                                                                          |

`directMode` (default on) spawns the configured command directly; off spawns a shell and writes
`clear && <command>` into it. `restart()`, `resumeActiveTerminal()` and `continueActiveTerminal()`
all go through `respawnActive()`, which reuses the tab's own cwd — session history lives per
directory.

## Rules for changes here

- **Terminal output is partly model-generated.** Treat it as untrusted input: that is why file
  links outside the workspace ask first and help probing runs without a shell against a name
  allowlist.
- **`ELECTRON_RUN_AS_NODE` belongs in a command string, never in the PTY env.** In the env every
  Electron app started from that terminal inherits it.
- **Showing or hiding the status line changes the terminal height.** Refit xterm afterwards, or
  it keeps the old row count.
- **`opacity` on an element dims its children**, so a progress track and its fill need separate
  colors rather than one color plus opacity.
- **A `\n` written into the PTY submits the prompt.** Anything multi-line has to go in wrapped in
  the bracketed paste markers `\x1b[200~` … `\x1b[201~`, or each line fires as its own prompt.
- **`media/xterm.css` is regenerated on every build.** Overrides belong in `media/styles.css`.
- UI strings are English.

## Do not reintroduce

- **`@electron/rebuild`, `node-abi`, `postinstall`.** `node-pty` 1.1.0 is N-API and therefore
  ABI-independent — no rebuild is needed when VS Code updates Electron. Measured: the same
  `pty.node` loads under Node ABI 115, 141 and 146.
- **Deleting `.vscodeignore`.** It is the only ignore file `vsce` honours while it exists —
  measured with 3.9.2: `dist/` added to `.gitignore` did **not** drop `dist/extension.js` from
  `vsce ls`. Remove `.vscodeignore` and `.gitignore` takes over, which would drop the build output
  and produce the misleading `Extension entrypoint(s) missing`.
- **A blanket negation of the whole `node-pty` folder in `.vscodeignore`.** `vsce` applies
  negations after every ignore pattern, so a line like

  ```
  !node_modules/node-pty/**
  ```

  pulls the whole module back in regardless of line order. Ignore all of `node_modules`, then
  negate exactly the paths that ship. For the same reason the Windows prebuilds are negated file
  by file: a `**` glob cannot be narrowed afterwards, and their `.pdb` debug symbols are 55 MB.

- **`--target` on `vsce package`.** A platform tag makes the `.vsix` refuse to install on any
  other architecture, and the fork has no rebuild step that would need one. Ship every prebuild
  instead.

## Learnings

See [LEARNINGS.md](LEARNINGS.md). Add new findings there, not here.
