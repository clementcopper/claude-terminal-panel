# Handoff — 2026-09-03 12:10

Arbeitsverzeichnis: /Users/danielmartin/claude-terminal-panel

## Stand

Alles liegt auf **`main`**, HEAD `4a09108`, gepusht nach `origin` (clementcopper); `feat/context-threshold`
ist lokal und remote gelöscht (2026-09-03, per Fast-Forward gemergt). Arbeitsbaum sauber. Gebaut und
installiert ist der Stand von `e71d73b`; Daniel hat alles bis auf die Resume-Rettung im Panel gesehen
und abgenommen.

Drin seit 2026-09-01: Statuszeile zentriert, sobald sie einzeilig ist und Panel > 400px
(`updateCentering`, gemessen, kein Breakpoint); Icons `semibold` mit Deckel pro Symbol, `+` 11px;
Gruppenleiste über der Tab-Leiste (`#body-row`), nur Linie unten, keine eigenen Radien;
Resume-Abbruch startet den Tab mit `--continue`, dann ohne Flags, dann Exit-Zeile.

## Mitten drin

- `Sessions/**` fehlt in `.vscodeignore` — `vsce ls` listet die Handoff-Dateien im `.vsix`.

## Nächster Schritt

`Sessions/**` in `.vscodeignore` eintragen, dann `npx vsce ls | grep Sessions` — muss leer sein.
Reload steht noch aus für `e71d73b`: `Resume` → ESC muss in dieselbe Sitzung zurückführen.

## Schon probiert, geht nicht

- `chrome-headless-shell --dump-dom` stellt keine `ResizeObserver`/`rAF`-Rückrufe zu; Resize-Pfade nur über CDP (`Emulation.setDeviceMetricsOverride` + `Page.captureScreenshot`). Rezept in `LEARNINGS.md` § Prüfwerkzeuge.
- Haarlinie links/rechts/oben an `#group-bar` und eigener 8px-Radius: doppelt VS Codes eigenen Rahmen. Verworfen, nur Linie unten.
- `semibold 44` in 48px beschneidet resume/continue/restart; größerer Rahmen schrumpft die Glyphe. Deckel pro Symbol im Skript.
- Shift+Pfeil im Prompt: Claude Code selbst kennt keine Auswahl (gemessen: Shift+← = ←, Shift+↑ = nichts). Nicht Panel-Sache.
- Framelink-MCP gibt es in diesem Projekt nicht; figma-cli braucht Daniels `connect`.

## Was Daniel entschieden hat

- Zentrieren erst, wenn alles in eine Zeile passt — nicht wörtlich ab 400px.
- Icons `semibold`; `+` in beiden Leisten 11px (Mitte zwischen 13 und 9); `plus.png` 36pt, `xmark.png` 44pt.
- Gruppenleiste: Linie **oben und unten**, Seiten und Radien weg — VS Code zeichnet Rahmen und Ecken selbst.
- Resume-Abbruch: aktiver Tab → `--continue` → frisch; neuer Tab → frisch. Kein Karussell.
- Maus-Markierung reicht; `macOptionClickForcesSelection` bleibt aus.

## Erledigt und vom Tisch

- Icon-Vergleichsbogen als Artifact (`claude.ai/code/artifact/9163bca2-…`) — Entscheidung gefallen, Watch beendet.
- Node-Pfad in `CLAUDE.md` korrigiert (v22.14.0 Standard, kein nvm-v20).
- Merge nach `main` erledigt, Feature-Branch weg.
