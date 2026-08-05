# Changelog

All notable changes to the "Claude Terminal Panel" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-08-05

Local fork, published nowhere: built and installed as `local.claude-terminal-panel-local`.

### Added

- Status line rendered natively at the bottom of the panel — model, effort, context bar, token
  count, session and weekly rate limits, compaction counter and working directory
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
