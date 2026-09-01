#!/bin/sh
# Regenerates media/icons from SF Symbols. macOS only, needs the Swift command line tools.
#
# AppKit rasterises symbols when they are drawn — an exported PDF contains `/Im1 Do`, not paths —
# so these are PNGs at 3x, not SVGs. VS Code scales them into a 16px box.
#
# Symbol availability follows the OS, not the SF Symbols app: a name from a newer release fails
# with SYMBOL NOT FOUND even when the app lists it.
set -e
cd "$(dirname "$0")/.."
BIN="$(mktemp -d)/render"
swiftc -O scripts/render-sf-symbol.swift -o "$BIN"

# Title bar and container. VS Code picks `light` for light themes, so that file carries the dark
# grey. The container contributes a single path with no light/dark pair, hence one balanced grey:
# #797979 measures 4.10:1 on Light Modern's #F8F8F8 and 4.08:1 on Dark Modern's #181818.
#
# `semibold` at 44pt: measured against VS Code's own codicons at 16px, `medium` at 36pt sat about
# three pixels of edge length under them and read thinner, because a downscaled PNG never lands as
# crisply as a hinted glyph from `codicon.ttf`.
#
# The point size is capped per symbol, because the ink of some symbols runs past the box AppKit
# lays out for them and the canvas then cuts it — at 44pt `clock.arrow.circlepath` measures 51px
# across in a 48px canvas. The numbers below are the largest size whose ink still leaves a pixel
# of margin on every side, measured symbol by symbol; a bigger shared canvas is not the way out,
# since VS Code scales the whole file into 16px and a wider canvas only shrinks the glyph again.
for spec in clock.arrow.circlepath:resume:40 forward.frame:continue:42 arrow.clockwise:restart:42; do
  name="${spec%%:*}"; rest="${spec#*:}"; slot="${rest%%:*}"; pt="${rest##*:}"
  "$BIN" "$name" semibold "$pt" 48 "#3B3B3B" "media/icons/$slot-light.png"
  "$BIN" "$name" semibold "$pt" 48 "#CCCCCC" "media/icons/$slot-dark.png"
done
"$BIN" viewfinder semibold 44 48 "#797979" media/icons/container.png

# Webview buttons are tinted by CSS `mask-image`, so only their alpha matters. The `+` stays at
# 36pt: it sits in the group bar rather than the title bar, so it is not next to a codicon and 44pt
# read too heavy there.
"$BIN" plus  semibold 36 48 alpha media/icons/plus.png
"$BIN" xmark semibold 44 48 alpha media/icons/xmark.png
