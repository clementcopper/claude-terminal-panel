# Learnings, improvements & dead ends — claude-terminal-panel (local fork)

Non-obvious findings and dead ends. Only add what saves future work.

## Packaging

- **`vsce` applies negations in `.vscodeignore` after every ignore pattern**, not in line order. A
  blanket `!node_modules/node-pty/**` therefore pulls the whole module back in, whatever
  exclusions follow it. The working shape is: ignore everything, then negate exactly the paths
  that ship. Result here: 15.64 MB → 608 KB.
- **`vsce` 3.9.2 collects zero files under Node 25** and then reports
  `Extension entrypoint(s) missing`, although the bundle exists — the message points at the wrong
  cause. Node 20 works. `vsce ls` printing nothing is how to recognise it.
- **`vsce` does NOT read `.gitignore` while `.vscodeignore` exists.** Measured with vsce 3.9.2:
  with `dist/` added to `.gitignore`, `vsce ls` still listed `dist/extension.js`. An earlier note
  here claimed the opposite — it was wrong. Consequence: anything that must stay out of the
  `.vsix` needs a line in `.vscodeignore`; a `.gitignore` entry is not enough (a screenshot
  dropped into the project folder shipped that way). Conversely `.gitignore` would only take over
  if `.vscodeignore` were deleted — and then the build output would fall out of the package.
- **`.git/info/exclude` settles the conflict between `git status` and `vsce`.** Build output
  cannot go into `.gitignore` by convention here, but sits in the working tree as untracked noise.
  An entry in `.git/info/exclude` hides it locally only; `vsce` does not read that file. Checked:
  `vsce ls` still lists `dist/extension.js`, `media/main.js` and `media/xterm.css` afterwards.

## Native module

- **`node-pty` 1.1.0 is N-API** (`napi_register_module_v1`), so it is ABI-independent. No rebuild
  when VS Code updates, and `@electron/rebuild` plus `node-abi` are superfluous. Evidence: the
  same `pty.node` loads under Node ABI 115, 141 and 146.
- **A directly started Electron (`ELECTRON_RUN_AS_NODE=1`) cannot load foreign `.node` files**:
  "mapping process and mapped file (non-platform) have different Team IDs". Library Validation
  bites there but not in the real extension host, so that route is **not** usable for ABI tests —
  load the same file under several nvm Node versions instead. Plain JavaScript is unaffected,
  which is why the bundled status line producer runs fine that way.
- **The loader only looks in `build/Release`, `build/Debug` and `prebuilds/<platform>-<arch>`**
  (`node_modules/node-pty/lib/utils.js`) and expects `spawn-helper` **in the same directory** as
  the loaded `pty.node`. `@electron/rebuild` puts its result under
  `bin/<platform>-<arch>-<abi>/node-pty.node` instead — which is never loaded.

## Claude Code

- **Claude Code stores session history per working directory** under `~/.claude/projects/<path>/`.
  A panel that starts in the wrong folder shows an empty `/resume` list with nothing actually
  broken. Hence the cwd in the tab tooltip and the `claudeTerminal.cwd` setting.
- **Claude's own colours do not follow the terminal theme.** Diff blocks and highlights arrive as
  absolute truecolor sequences matching Claude's `theme` setting — without an entry in
  `~/.claude/settings.json` that is the dark default. On a light VS Code theme the result is
  unreadable, and the extension cannot fix it: it only supplies background, foreground and the 16
  ANSI slots. The remedy is Claude's own theme (`/theme`); an ANSI-based variant would reuse the
  values the extension provides. There is no `COLORFGBG` in the PTY either, so Claude gets no hint
  about light or dark.

## Webview

- **`xterm.css` paints the viewport `#000`** (`.xterm .xterm-viewport`, line 93 — a workaround for
  opaque macOS scrollbars). xterm colours the cells from its theme but not that surface, and
  `FitAddon` works in whole rows, so the leftover strip below the last row showed as a black band
  once the wrapper lost its padding. The override belongs in `styles.css`: `media/xterm.css` is
  copied fresh from `node_modules` on every `npm run compile`.
- **`opacity` on an element dims its children too.** A progress track with `opacity: 0.25` and a
  fill in the same colour therefore looks completely empty — the fill inherits the 25 %. Track and
  fill need their own colours instead of one colour plus opacity.
- **`direction: rtl` for a left-side ellipsis reverses plain ASCII paths**:
  `~/claude-terminal-panel` came out as `claude-terminal-panel/~`, because `/` and `~` are
  bidirectionally neutral. Shortening in code is more reliable than the CSS trick.
- **xterm themes are a snapshot, not a CSS binding.** `theme` takes finished colour values, so a
  terminal only follows a VS Code theme change if the values are handed over again. A
  `MutationObserver` on `class`/`style` of `<html>` and `<body>` is enough — VS Code rewrites the
  `--vscode-*` variables while the theme picker is merely browsed, which is why debouncing is
  needed.
