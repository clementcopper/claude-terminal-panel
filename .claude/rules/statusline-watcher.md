---
paths:
  - 'src/statusLineWatcher.ts'
  - 'resources/panel-statusline.js'
---

# Status line data path (watcher and producer)

- **The producer runs on every render; never read the whole transcript there.** 440–1040 ms per render on a 16.8 MB session, measured. Compaction counts live under `<tmpdir>/claude-terminal-panel/compactions/` with a byte offset; only the appended bytes are scanned. Keep that cache outside the status directories — the watcher reads every `.json` there as a snapshot.

Distilled from `LEARNINGS.md` § Statuszeile (file side) and § Claude Code (statusLine trigger). Stories are there.

- **The status folder in `$TMPDIR` is machine-wide.** Every VS Code window of the user shared `claude-terminal-panel/status`; cleanup killed other windows' live tabs. Hence `status/<window token>/`.
- **A missing file is no proof of a dead tab.** Only `removeTerminal` knows that; any other deletion must keep the last snapshot.
- **A folder that can be cleaned up needs a heartbeat.** Idle windows write nothing for days; without periodic `utimes` on the own folder the next start treats it as orphaned, and a deleted folder takes the inode-bound `fs.watch` with it silently.
- **The statusLine command runs on session state changes, not on renders.** Resize, focus, Escape, slash menu, typing: no run; only `shift+tab` (permission cycle) triggers it. Measured with a node-pty probe using the panel's own `--settings` injection.
- **There is no token-free refresh.** Cycling the permission mode passes through accept-edits and does not reliably return to the start; `claude --help` offers nothing that reports usage. Only rate limits go stale, so the countdown is recomputed in the webview from `sessionResetsAt`.
- **`Session 0%` at `Week 100%` is credit mode, not a broken transfer.** Claude Code reports `five_hour.used_percentage` as 0 once turns run on usage credits; the producer passes it through, `parseSnapshot` maps `null` to `undefined`. Look at `status/<tab>.json` (age, `usedTokens`) before debugging.
