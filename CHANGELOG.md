# Changelog

All notable changes to the "Claude Terminal Panel" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Two levels of tabs.** Claude Terminal tabs (groups) each hold their own terminal tabs. The
  group bar runs horizontally above the terminal, its `+` behind the tabs; the vertical bar on the
  right keeps showing the active group's terminals. A group owns a working directory and every
  terminal opened in it starts there, so a group is effectively one project.
- Group commands: `Claude Terminal: New Terminal Tab`, `Close Terminal Tab`, `Next Terminal Tab`
  (`Cmd+Alt+Down`) and `Previous Terminal Tab` (`Cmd+Alt+Up`).
- A group is **named after its working directory** — `claude-terminal-panel`, `figma-cli` — and
  coloured by the CLI it runs, on a 2px accent bar along the group tab's bottom edge. The bar is a
  pseudo-element rather than a border, so dimming it for an inactive group leaves the tab's name
  and its notification pill at full contrast. Names are never truncated; the bar scrolls sideways
  instead, with the `+` pinned to its right edge.
- **The tab layout is remembered per workspace.** Group names, directories, CLIs, order, tab counts
  and which tab was on screen go into `workspaceState`, so a window reload or a VS Code restart
  comes back to the same groups. Only the shape returns — the processes die with the extension
  host, so every restored tab is **cold**: it holds its place in the bar and starts its CLI the
  first time it is switched to. A reload with four groups therefore costs one session, not four.
  A group whose directory has since disappeared is dropped rather than restored.
- **Double-click a group tab to rename it.** The name turns into a text field in place: Enter
  commits, Escape reverts, clicking away commits. An empty name is refused. A rename in progress
  survives a redraw of the bar, so an unrelated group's notification cannot eat what you typed.
- A terminal waiting for input in a group that is off screen shows its pill on the group tab.
- Choose the engine when opening a tab group: `Claude Terminal: New Terminal Tab` and the `+` in
  the group bar ask **Claude Code** or **OpenCode**. The answer fixes that group's CLI, and the
  first group after the panel opens starts the configured engine without asking.
- Each tab remembers its engine (`claude` / `opencode`); `Restart`, `Resume` and `Continue` reuse
  the tab's own engine instead of falling back to the configured Claude command.
- `claudeTerminal.opencodeCommand` (default `opencode`) — the command an OpenCode tab runs.
- Tab tooltips show the engine alongside the working directory.

### Changed

- The `$(add)` button left the view title bar — VS Code right-aligns title-bar actions, so a `+`
  beside the group tabs had to be drawn by the webview. The title bar keeps Resume, Continue and
  Restart.
- `Cmd+Shift+\`` is now `New Terminal`(a tab inside the current group);`New Terminal Tab`opens
a group.`Close`/`Next`/`Previous Terminal` were renamed to match.
- **A tab group runs one CLI.** The `+` in the terminal bar and `Cmd+Shift+\`` no longer ask which
engine to run — they open another terminal of the group's own, so Claude tabs only ever sit in
Claude groups and OpenCode tabs in OpenCode groups. The engine question moved up one level, to
where a group is created, and the `+` tooltip names the CLI it will open.
- `New Terminal (Resume Session…)` and `(Continue Last Session)` are refused in an OpenCode group
  with a message instead of dropping a Claude tab into it — `--resume` / `--continue` are
  Claude-only flags.
- **The panel's icons are SF Symbols**, rendered from macOS by `scripts/render-icons.sh`:
  `clock.arrow.circlepath` for Resume, `forward.frame` for Continue, `arrow.clockwise` for Restart,
  `viewfinder` for the view container, `plus` and `xmark` for the webview's buttons — all at SF Pro
  Medium.

  The codicons they replace could not be made consistent. VS Code colours the debug ones globally
  through a theming participant (Continue `#007ACC`/`#75BEFF`, Restart `#388A34`/`#89D185`) while
  `$(history)` fell through to `icon.foreground` — `#3B3B3B` in Light Modern, which reads as black
  beside them — and it was also the lightest of the three: measured at 16px it carried 49.4 ink
  against 60.7 and 60.3. Nothing in the coloured debug family combined a distinct shape, a matching
  weight and a sensible meaning; SF Symbols have the weight axis that makes the set consistent.

  All six are now the theme's own grey, so no icon stands out from the workbench. AppKit rasterises
  symbols when it draws them, so these are PNGs at 3x rather than SVGs. The webview's `plus` and
  `xmark` are applied as CSS `mask-image` with `background-color: currentColor`, which keeps one
  file per icon and lets them follow the theme the way a codicon does — the webview CSP gained an
  `img-src` for that.

- Cycling tabs stays inside the active group, so the shortcut cannot land in another directory.
- A new terminal inherits its group's working directory instead of asking again; the directory is
  asked for once, when the group is created.

### Removed

- **`New Terminal with Custom Command`**, and the four modules only it reached —
  `commandInputPicker`, `commandHelpParser`, `pathAutocompleteProvider`, `helpExecutor`, 1,144
  lines together — plus the `claudeTerminal.preloadHelp` setting that fed them. The panel supports
  Claude Code and OpenCode and nothing else, so a free-text command line had no remaining job, and
  it was the last way to put a tab of one CLI inside a group of the other. The right-hand bar keeps
  one button, the `+`. Per-tab flags go in `claudeTerminal.args`; `New Terminal (Resume Session…)`
  and `(Continue Last Session)` are unaffected. The extension bundle drops from 122 KB to 95 KB.

### Fixed

- The first row count handed to a new PTY is measured against a real `.terminal-wrapper` in the
  terminals container instead of being reconstructed from the viewport. The old arithmetic
  hardcoded the tab bar's 36px and ignored the wrapper's 10px/6px insets: measured at a 320px ×
  600px panel it reported 37 rows where the wrapper fits 34 — and it would have missed the new
  group bar on top of that. The estimate now matches the tab's own `terminalReady` exactly.

### Notes

- OpenCode tabs get no status line (that row is Claude-specific), and the Claude-only
  `--resume` / `--continue` session flags do not apply to them.
- A window reload brings the groups back, but not their processes: restored tabs are cold and
  start their CLI the first time they are looked at.

## [1.1.0] - 2026-08-05

Local fork, published nowhere: built and installed as `local.claude-terminal-panel-local`.

### Added

- Status line rendered natively at the bottom of the panel — model, effort, working directory and
  four rings for context, session limit, weekly limit and compactions. The context ring fills
  against the threshold and asks for a new one when clicked
- Per-window status directory (`status/<window token>`), so one VS Code window can no longer
  delete another window's live snapshots and blank its status line
- Bundled status line producer (`resources/panel-statusline.js`), handed to Claude Code per
  session through `--settings`, so the row works without touching `~/.claude/settings.json`
- `claudeTerminal.statusLine`, `claudeTerminal.statusLineProvider` (`bundled` / `own`) and
  `claudeTerminal.statusLineCompactBudget`
- `Resume Session in Current Tab…` and `Continue Last Session in Current Tab` — both in the view
  title bar, both respawning the active tab instead of opening another one
- `New Terminal Tab (Resume Session…)` and `New Terminal Tab (Continue Last Session)`, Command
  Palette only
- `claudeTerminal.cwd` to pin the working directory, `~` allowed — Claude Code stores session
  history per directory, so this keeps `/resume` showing the same sessions
- `claudeTerminal.preloadHelp` to opt into probing other CLI agents for `--help`

### Changed

- The terminal fills its column edge to edge; the remaining inset carries the terminal
  background instead of showing the page behind it as a frame
- Terminals follow VS Code theme changes live, including while the theme picker is browsed
- `Restart Terminal` respawns in the tab's own working directory rather than the first workspace
  folder, which silently changed which session history applied
- Tab tooltips show the working directory
- Help probing runs without a shell and only for command names matching `^[A-Za-z0-9._@/-]+$`;
  probing other agents is now off by default
- File links pointing outside the workspace and the terminal's directory ask before opening —
  terminal output is partly model-generated
- The webview nonce comes from `crypto.randomBytes` instead of `Math.random`

### Fixed

- The `.vsix` is installable on Intel and ARM alike. It carried only the `darwin-arm64` prebuild
  behind a `--target darwin-arm64` tag, so on an Intel machine the panel died at startup with
  `Cannot find module './prebuilds/darwin-x64//pty.node'`. All four prebuilds ship now —
  `darwin-x64`, `darwin-arm64`, `win32-x64`, `win32-arm64` — without a platform tag, 2.96 MB total
- `spawn-helper` ships executable. It arrived at 644 from `npm ci` and `vsce` stored that mode, so
  `pty.node` loaded and every spawn failed with `posix_spawnp failed`

### Added

- `scripts/verify-package-payload.js`, run as `prepackage` and `postpackage`: restores the
  executable bit, rejects an incomplete prebuild set, and keeps `.pdb` debug symbols (55 MB) out
- An editor row above the status line: the open file, plus the selected line range when there is
  one. Clicking it — or `Claude Terminal: Add Editor Selection to Prompt`, `cmd+alt+k` — puts the
  selected code into Claude's input as a fenced block headed by `path:line`, and `@path` when
  nothing is selected. A mention would pull the whole file: measured on a 270-line file, 7422
  bytes for 120 bytes of selection. Nothing is attached automatically;
  `claudeTerminal.editorContext` hides the row and leaves the command working

### Removed

- `@electron/rebuild`, `node-abi` and the `postinstall` script. `node-pty` 1.1.0 is N-API and
  therefore ABI-independent: the same `pty.node` loads under Node ABI 115, 141 and 146

## [1.0.10] - 2026-01-14

### Added

- Path autocomplete for command flags that accept file/directory paths
- Smart detection of path-accepting flags via value hints (`<path>`, `<file>`, `<directory>`, `<directories...>`)
- Hidden file support when user explicitly types a dot prefix
- Support for `~/` home directory paths with proper tilde notation in suggestions

## [1.0.9] - 2026-01-12

### Added

- Clickable file path links in terminal output
- File paths with line:column format support (e.g., `src/file.ts:10:5`)
- Navigation to specific line and column when clicking file paths
- Respects terminal's working directory for relative path resolution

## [1.0.8] - 2026-01-08

### Changed

- Improved scrollbar styling for xterm terminal with better visibility and consistency
- Updated README documentation with VS Code version details and feature enhancements

## [1.0.7] - 2026-01-08

### Changed

- Updated build scripts with separate extension and media compilation
- Bundled xterm.css locally instead of loading from external CDN
- Updated Content Security Policy for improved security
- Updated dependencies: @types/node, @xterm/addon-fit, @xterm/addon-web-links, @xterm/xterm, esbuild, eslint-config-prettier, globals, lint-staged

## [1.0.6] - 2026-01-08

### Added

- Notification pill for terminal input prompts
- Accent color support for terminal tabs

### Changed

- Improved flag addition in command input picker

## [1.0.5] - 2026-01-08

### Added

- Custom command button for creating new terminal instances
- Working directory selection when creating new terminals

### Removed

- Clear terminal command (removed from command palette)

## [1.0.4] - 2026-01-08

### Added

- Scroll management for terminal viewport
- Auto-scroll behavior with scroll position tracking

## [1.0.3] - 2026-01-07

### Changed

- Updated VS Code engine requirement to version 1.106.0
- Enhanced README with multi-tab support features and keyboard shortcuts

## [1.0.2] - 2026-01-07

### Added

- Multi-tab terminal functionality
- New xterm addons for improved terminal experience
- Support for multiple concurrent terminal instances

### Changed

- Improved tab close button styles
- Enhanced terminal instance activation logic
- Updated supported tools documentation with new AI CLI options

## [1.0.1] - 2026-01-06

### Added

- New extension icon/logo
- Screenshot in README for visual reference

### Changed

- Improved release workflow for multi-architecture support

## [1.0.0] - 2025-01-06

### Added

- Initial release
- Dedicated terminal panel in VS Code activity bar
- Support for Claude Code, Gemini CLI, Aider, OpenAI Codex, and any CLI tool
- Full xterm.js terminal emulation with 256-color support
- VS Code theme integration (automatically syncs with your theme)
- Dual execution modes:
  - Direct mode: Runs command directly for cleaner output
  - Shell mode: Spawns shell with full shell features (pipes, redirects, etc.)
- Auto-run on startup (configurable)
- Quick actions: Restart and Clear terminal
- Configurable settings:
  - Custom command and arguments
  - Custom shell path
  - Additional environment variables
  - Direct mode toggle
