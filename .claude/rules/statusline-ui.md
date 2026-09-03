---
paths:
  - 'media/main.ts'
  - 'media/styles.css'
---

# Status line UI (rings, wrapping, fonts, contrast)

Distilled from `LEARNINGS.md` § Statuszeile (CSS side) and § Schriften und Scrollbar im Panel. Measured tables are there.

## Rings and wrapping

- **Round caps eat the gap; plan the gap to include them.** `stroke-linecap: round` extends each end by `(strokeWidth/2)/r` in radians (5.7° at r 16.38, stroke 3.24); the compaction ring's 14° gaps became 2.7°. Gap = intended gap + `2·(strokeWidth/2)/r`; 21° with 86° segments keeps round ends on all four rings.
- **A ring fill needs no trigonometry.** `<circle>` with `stroke-dasharray: 2πr`, `rotate(120 18 18)`, `dashoffset = 2πr − f·(2πr·300/360)`; Figma path data drifts at the ends.
- **The main row is one flat sequence, not a head plus a ring block.** Stop, model, then each ring group as its own flex item; a container around the rings was one item and dropped all four to the next line together. As siblings they wrap one at a time and the stop button, first in the DOM, holds the line start at every width. Measured steps live in `README.local.md` (≥439 / 253–438 / 191–252 / 177–190 / <177 px with the long `HIGH · FAST` badge) — re-measure after any font change, they moved 20–40 px with SF Compact Display.
- **Flex wraps on the hypothetical size (`flex-basis: auto` = content width), then shrinks.** A `min-width` floor on a wrapper only changes where the whole block breaks; it never lets items wrap individually. Check the child's right edge against the parent's inner edge, `scrollWidth - clientWidth` stays 0.
- **Centring is measured, not a breakpoint.** `StatusLineView.updateCentering()` sets `.centered` when every item of the main row shares one `offsetTop` and the panel is wider than 400 px; a `ResizeObserver` on the status line reruns it, and `justify-content` changes neither the wrap nor the height, so it cannot feed itself. Reconstructing the threshold from tab bar plus padding is the mistake `measureInitialDimensions` once made.
- **Figma frame spacing is schematic.** The width mocks (`915:6228`) use `itemSpacing: 8` everywhere while their noted wrap ranges come from the shipped 12/24; take alignment from a frame, verify every other number against the build before adopting it.

## Fonts

- **"SF Pro Compact" does not exist.** Families are `SF Pro` and `SF Compact` with `Display`/`Text`/`Rounded`; `SF Mono` is registered from Terminal.app's bundle. Check with `system_profiler SPFontsDataType`.
- **A font in the stack is not a font that resolves.** Prove it with `document.fonts.check(...)` plus a `canvas.measureText` width against the fallback; equal width means silent fallback.
- **Every `var()` in a font stack carries its own fallback.** `'SF Mono', var(--vscode-editor-font-family), Menlo` is invalid when the token is missing: no font family at all, not Menlo.

## Colour and contrast

- **VS Code tokens guarantee no contrast; compose alpha over the real ground and measure per theme.** `--vscode-disabledForeground` is `#CCCCCC80` in Dark Modern, 3.69:1 on `#181818`; token values come from `theme-defaults/themes/*.json` following the `include` chain.
- **Hue beats contrast for warning colours, deliberately.** Any yellow/orange that reaches 4.5:1 on light ground reads as brown (`#8A6200` 5.17:1); keep the saturated 3.24 px arc, put the number on the text colour.
- **Hierarchy from two greys does not survive the mode switch.** Light Modern collapses `foreground` and `descriptionForeground` to `#3B3B3B`; one colour, difference by font weight.
