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
for pair in clock.arrow.circlepath:resume forward.frame:continue arrow.clockwise:restart; do
  name="${pair%%:*}"; slot="${pair##*:}"
  "$BIN" "$name" medium 36 48 "#3B3B3B" "media/icons/$slot-light.png"
  "$BIN" "$name" medium 36 48 "#CCCCCC" "media/icons/$slot-dark.png"
done
"$BIN" viewfinder medium 36 48 "#797979" media/icons/container.png

# Webview buttons are tinted by CSS `mask-image`, so only their alpha matters.
"$BIN" plus  medium 36 48 alpha media/icons/plus.png
"$BIN" xmark medium 36 48 alpha media/icons/xmark.png
