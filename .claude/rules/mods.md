---
paths:
  - 'resources/mods/**'
  - 'src/statusLineWatcher.ts'
  - 'src/ptyManager.ts'
---

# The panel-bridge mod (Claude Code function hooks)

Distilled from `LEARNINGS.md` § Live-Brücke, which holds the evidence.

- `claude plugin validate` refuses storing or passing `$`; hand helpers lambdas that spell `$.clock.after(...)` and `$.fs.write(...)` inside the hook.
- The engine writes the mod's types into `<mod>/.claude-plugin/types/` at every load, headless too (`claude --plugin-dir <mod> -p ok`); `npm run typecheck:mod` needs them and stays out of `vscode:prepublish`. Git-ignored, never packaged.
- Load the mod through `CLAUDE_CODE_PLUGIN_DIRS`, never `--plugin-dir`: an old Claude Code ignores the variable but exits on the flag.
- The mod removes its own folder from `CLAUDE_CODE_PLUGIN_DIRS` at `session.start`, or a nested `claude -p` from a Bash tool loads it and overwrites the tab's file.
- Remember `stripLive(merged)` for a cwd, never the merged snapshot; `model` stays the producer's display name, the mod's id goes to `modelId`.
- A mod test gives bottoms for every noun and event it touches (`fs.write`, `env.set`, `session.usage` as `{ value }`, `classic.PermissionRequest` as `{}`, `turn.step` as a result-only `async function*`); registering one twice stops the module from loading.
- A real `claude` in a probe PTY stops at the workspace-trust dialog in a new directory: answer it (`\x1b[B`, `\r`) and strip `CLAUDECODE` from the env first.
- End-to-end check: `scratchpad/e2e/run.js` pattern — node-pty, the panel's two env vars plus the plugin dir, poll `<tab>.live.json`, expect idle → busy → tool → per-step tokens → idle.
