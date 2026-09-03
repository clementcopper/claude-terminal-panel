---
paths:
  - 'src/**'
---

# Extension host (PTY, spawn, prompt, inter-agent)

Distilled from `LEARNINGS.md` § Claude Code, § Prompt input, § Inter-agent channel, § Terminal-Start im Panel (host side), § OpenCode-Startzeit and § OpenCode theme. Stories and measurements are there.

## Spawning

- **Resolve commands to absolute paths before `spawn` (`PtyManager.resolveCommand`).** The extension host inherits Finder's PATH, not the login shell's; node-pty reports a missing binary as `[Process exited with code 1]` with no text. Search host PATH plus `~/.local/bin`, `~/.opencode/bin`, `~/bin`.
- **One PTY owner: `PtyManager`.** A second spawn path silently loses `--settings` with the bundled status line producer, `CLAUDE_PANEL_TAB_ID`/`_STATUS_DIR`, `config.env`, `delete env.CI` and `directMode`; nothing throws. Do not share ownership.
- **A cold or restored tab starts only after its window is measured (`terminalReady`).** The estimated size was seven rows off; a restored tab has already spent its one `terminalReady`, so waking goes `startTerminal` → `readySent = false` → refit → report. Restart/resume/continue (`respawnTerminal`) spawn directly with `lastCols/lastRows` on purpose — the tab is already measured, and the exit-recovery path reuses that route.
- **Check whether a tab should be running before forwarding its `terminalReady`.** Cold tabs otherwise log `resize of unknown terminal` on every reload, and a warning that fires every start is no warning.
- **Never `killAll()` in the webview's `onDidDispose`.** The webview is rebuilt when the panel moves to the other sidebar; processes keep running, `handleReady` restores the tabs, the old webview reference is dropped.
- **Identity, not a time window.** Exit and data handlers compare the PTY instance with the one registered for the tab id; a 100 ms suppression flag let `[Process exited with code 129]` and stale bytes land in the fresh session.
- **`claudeTerminal.env` already exists for PTY environment variables.** `buildEnvironment` merges it, `ConfigManager` drops its cache on change, effective at next spawn; check before proposing a new setting.
- **Claude Code's selection dialogs exit with code 1.** `claude --resume` + Escape and `claude --continue` without a session both end the process; a tab restarted for `--resume` must catch that, the previous session is already dead.
- **Session history is per working directory** (`~/.claude/projects/<path>/`). A wrong cwd shows an empty `/resume` list with nothing broken; hence the cwd tooltip and `claudeTerminal.cwd`.

## Prompt and paste

- **An at-mention pulls the whole file; a line range in it is prose.** `@src/foo.ts (lines 264-268)` sends 7422 bytes for 120 bytes of selection; to send the selection, put the text in the prompt.
- **A quoted snippet needs a fence longer than any backtick run inside it** (longest run + 1, minimum three), or a template literal closes the block early.

## Inter-agent channel

- **A lookup that must never miss gets a loud `console.warn` in the miss branch.** `this.ptys.get(id)?.write(data)` dropped every keystroke for three commits without a log line.
- **Broadcast fan-out needs its own msgId per recipient, and only the sender's window fans out.** Copies return through the same reader; with the original's msgId the dedup map eats them, and every window watches the same tmp directory.
- **An append-only JSONL watcher starts at the current file size.** Otherwise the whole history is "new" at window start and gets pasted into fresh tabs.

## Agents and themes

- **Claude's own colours ignore the terminal theme.** Diff blocks arrive as absolute truecolor from Claude's `theme` setting; the extension supplies only background, foreground and 16 ANSI slots, and there is no `COLORFGBG`. Remedy is `/theme`, not the extension.
- **The OpenCode theme poke rides on the webview's `themeApplied`, not on `onDidChangeActiveColorTheme`.** VS Code's event fires before the webview repaints xterm's background; host writes `\x1b[?997;1n` into each OpenCode tab only after `themeApplied` and only when the appearance bucket changed.
- **A warm `opencode serve` is not worth it.** 5.1–5.4 s to first visible output, `attach` saves 1.3 s and buys a background process plus an unsecured local endpoint; where the time goes is in `~/.local/share/opencode/log/opencode.log` (`run=` id, `init count`).
