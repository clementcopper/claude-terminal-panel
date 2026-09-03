---
paths:
  - '.vscodeignore'
  - 'package.json'
  - 'scripts/**'
  - '.github/**'
  - 'media/icons/**'
---

# Packaging, native module, icons

Distilled from `LEARNINGS.md` § Packaging, § Native module and the icon bullets in § Terminal-Start im Panel. The vsce/`.vscodeignore`/`--target`/Node rules already live in `CLAUDE.md` and are not repeated.

- **`vsce` matches ignore patterns case-sensitively, git does not.** `Screenshot*.png` in `.gitignore` hides `screenshot_2.png`, the same line in `.vscodeignore` shipped it (1.9 MB of a 3 MB package). Check the payload by size, not by what git shows.
- **`.git/info/exclude` hides build output from `git status` only.** `vsce` does not read it; `vsce ls` still lists `dist/extension.js`, `media/main.js`, `media/xterm.css`.
- **`spawn-helper` arrives at 644 and nothing restores the bit.** The symptom is `pty.fork` dying with `Error: posix_spawnp failed`, not a load error; `scripts/verify-package-payload.js` fixes it at packaging time.
- **The loader looks only in `build/Release`, `build/Debug`, `prebuilds/<platform>-<arch>` and wants `spawn-helper` beside `pty.node`.** `@electron/rebuild`'s `bin/<platform>-<arch>-<abi>/` is never loaded.
- **A directly started Electron (`ELECTRON_RUN_AS_NODE=1`) cannot load foreign `.node` files** ("different Team IDs"); test ABI compatibility under several nvm Node versions instead. Plain JavaScript is unaffected.
- **AppKit rasterises SF Symbols; there is no vector path.** PDF context yields an image, the fallback font's glyph names resolve only at runtime. Render PNG at 3x (`scripts/render-icons.sh`) or draw by hand.
- **SF Symbol availability follows the OS, not the app.** `NSImage(systemSymbolName:)` returns `nil` on macOS 13 for SF Symbols 6 names; run every new name through the render script first, `SYMBOL NOT FOUND` is the only feedback.
- **VS Code colours the debug codicons globally, and the class name is built at runtime.** `grep codicon-debug-continue` finds nothing in the bundle although the rule applies; never infer missing behaviour from a missing literal in VS Code chrome.
- **`contributes.commands.icon` takes a light/dark pair, `viewsContainers.icon` does not.** The container needs one tone for both grounds: `#797979` measures 4.10:1 on `#F8F8F8` and 4.08:1 on `#181818`.
- **A bigger canvas shrinks the icon; cap the point size per symbol instead.** VS Code scales the whole PNG into 16px, so ink that overruns the 48px canvas is cut, not fitted; use the largest size whose ink leaves 1px on every side (resume 40, continue/restart 42, rest 44) and compare with the codicons at 16px by box and ink mass, not by the source glyph.
- **`Sessions/**`is missing from`.vscodeignore`** — `vsce ls`lists the handoff files; add the line and check with`vsce ls | grep Sessions`.
