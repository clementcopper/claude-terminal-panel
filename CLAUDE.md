# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A local fork of [Nolikzero/claude-terminal-panel](https://github.com/Nolikzero/claude-terminal-panel),
a VS Code extension that runs Claude Code in a PTY inside the secondary sidebar. It is built
and installed **only on this machine** as `local.claude-terminal-panel-local`; the Marketplace
version is uninstalled. Renamed on purpose so a Marketplace update cannot overwrite it.

| File | Contents |
|---|---|
| `README.local.md` | build recipe, package contents, list of differences from upstream |
| `LEARNINGS.md` | tool quirks and dead ends — add findings there, not here |
| `README.md` | upstream's own readme, untouched |

## Commands

Node 20 is required for anything that touches `vsce` (see Build gotchas):

```sh
export PATH="$HOME/.nvm/versions/node/v20.19.0/bin:$PATH"
```

| Task | Command |
|---|---|
| Install | `npm ci` |
| Full build | `npm run compile` (extension bundle + `media/main.js` + copies `xterm.css`) |
| Extension only, watching | `npm run watch` |
| Lint | `npm run lint` / `npm run lint:fix` |
| Format | `npm run format` / `npm run format:check` |
| Package `.vsix` | `npm run package` (darwin-arm64, `--skip-license`) |
| Install the build | `"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --install-extension claude-terminal-panel-local-darwin-arm64-<version>.vsix` |

**There is no test suite** — no test script, no framework, no `.vscode-test`. Verification is:
`npm run lint && npm run compile`, then package and reload the VS Code window and exercise the
panel by hand. Never claim a change works without that reload.

Type-checking happens through esbuild bundling only (`tsc` is not in the build chain); run
`npx tsc --noEmit -p tsconfig.json` when a change touches types.

## Git — read before running anything

- **`origin` is the upstream repo, not ours** (`Nolikzero/claude-terminal-panel`, HTTPS). Never
  push there; there is no write access, and it is not our repository. Fetch from it to compare
  or merge.
- **`fork` is ours** (`clementcopper/claude-terminal-panel`, SSH), and `main` tracks `fork/main`.
  Push only when asked, and only to `fork`.
- **Never create a `v*` tag.** `.github/workflows/release.yml` is upstream's, still runs
  `@electron/rebuild` and ends in `vsce publish` with `VSCE_PAT`. It has no business running for
  this fork.
- **The clone is shallow** (`--depth 1`). Before comparing against upstream or reading history,
  run `git fetch --unshallow`.
- Unlike the quartz fork, **upstream is a live repository** — merges are realistic here. Keep
  changes small and localized, prefer additive edits over restructuring.

## Architecture

Two separately bundled halves that only talk through `postMessage`.

**Extension host** (`src/`, bundled to `dist/extension.js`, CJS, `vscode` and `node-pty`
external). `extension.ts` registers the webview provider plus every command and forwards them to
the single `ClaudeTerminalViewProvider`. That class is the hub: it implements both
`vscode.WebviewViewProvider` and `MessageHandlerContext`, and delegates everything else.

**Webview** (`media/main.ts`, bundled to `media/main.js`, IIFE, browser platform, own
`media/tsconfig.json` for DOM libs). `WebviewContext` owns one xterm.js `Terminal` per tab,
the tab bar DOM, `FitAddon` resizing and `FileLinkProvider` (clickable `path:line:col` in
output). Loaded from generated HTML with a strict CSP and a per-load nonce.

Message flow: webview `postMessage` → `onDidReceiveMessage` → `dispatchMessage`
(`src/messageHandlers.ts`, a typed handler map keyed by message `type`, exhaustive by
construction) → a `handle*` method on the provider. Return traffic goes through the provider's
private `postMessage` and a mirror handler map at `media/main.ts:241`.

**Message contracts are duplicated on purpose.** `src/types.ts` (`WebviewMessage`,
`ExtensionMessage`, `TabInfo`) and `media/types.ts` (`WebviewOutgoingMessage`,
`WebviewIncomingMessage`, `TabInfo`) are separate declarations of the same unions — the two
bundles share no module. Adding a message means editing both, plus `messageHandlers.ts` (the
map is exhaustive, so a missing entry fails the build) and the webview's map (it is not).

Supporting modules, each owning one concern:

| Module | Role |
|---|---|
| `ptyManager.ts` | spawns/kills PTYs, resolves the cwd, builds the env (`TERM`, `FORCE_COLOR`, deletes `CI`), lazily `require`s `node-pty` |
| `terminalStateManager.ts` | the tab model — instances, active id, names, accent colors, `TabInfo` for the UI |
| `configManager.ts` | cached `claudeTerminal.*` settings, invalidated on config change |
| `promptDetector.ts` | strips ANSI, buffers output, matches prompt patterns after a delay to flag "waiting for input" |
| `commandInputPicker.ts` | the "new tab with command" QuickPick, with flag and path completion |
| `helpExecutor.ts` + `commandHelpParser.ts` | run `<cmd> --help` and parse it (GNU → argparse → fallback parser chain) into `CommandFlag`s |
| `pathAutocompleteProvider.ts` | debounced, cached directory listings for flag values |

`directMode` (default on) spawns the configured command directly; off spawns a shell and writes
`clear && <command>` into it. `restart()` respawns in the tab's own cwd, not the workspace root.

## Build gotchas

- **Use Node 20** (`~/.nvm/versions/node/v20.19.0/bin`). `vsce` 3.9.2 collects zero files under
  Node 25 and then reports `Extension entrypoint(s) missing`, pointing at the wrong cause.
  `vsce ls` printing nothing is the tell.
- **Never publish.** No `vsce publish`, no Marketplace, no `VSCE_PAT`. `npm run package` builds
  a `.vsix`; installing is a separate, explicit step.

## Do not reintroduce

- **`@electron/rebuild`, `node-abi`, `postinstall`.** `node-pty` 1.1.0 is N-API and therefore
  ABI-independent — no rebuild is needed when VS Code updates Electron. Measured: the same
  `pty.node` loads under Node ABI 115, 141 and 146.
- **Build outputs in `.gitignore`.** `vsce` reads that file too, so an entry for `dist/`,
  `media/main.js` or `media/xterm.css` drops it from the package. The comment there says so.
- **A blanket `!node_modules/node-pty/**` in `.vscodeignore`.** `vsce` applies negations after
  every ignore pattern, so it pulls the whole module back in regardless of line order. Ignore
  all of `node_modules`, then negate exactly the paths that ship.

## What this fork adds

**Session handling.** Claude Code stores its history per working directory under
`~/.claude/projects/<path>/`. A panel started in an unexpected folder shows an empty `/resume`
list with nothing actually broken. Therefore: the tab tooltip carries the cwd, `restart()`
reuses the tab's own cwd, `claudeTerminal.cwd` pins the directory, and two commands expose
`--continue` and `--resume`.

**Hardening.** Help probing runs without a shell and only for names matching
`^[A-Za-z0-9._@/-]+$`; `claudeTerminal.preloadHelp` defaults to off; file links outside the
workspace and the terminal's cwd ask before opening; the webview nonce comes from
`crypto.randomBytes`. Keep new code in that spirit: terminal output is partly model-generated,
so treat it as untrusted input.

## Native module — the load path

`node-pty` loads its binary from `build/Release`, `build/Debug` or
`prebuilds/<platform>-<arch>` only (`node_modules/node-pty/lib/utils.js`), and `spawn-helper`
must sit in the same directory as the loaded `pty.node`. `.vscodeignore` keeps exactly those
paths. Any change there needs the packaged `.vsix` re-checked:

```sh
unzip -l *.vsix | grep -E "node-pty.*(\.node|spawn-helper)"
```

Expected: `build/Release/pty.node` and `build/Release/spawn-helper`, plus the same two under
`prebuilds/darwin-arm64/`. No `win32-*`, no `bin/`.

UI strings are English.

## Learnings

See [LEARNINGS.md](LEARNINGS.md). Add new findings there, not here.
