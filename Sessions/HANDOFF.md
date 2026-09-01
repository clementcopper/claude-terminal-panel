# Handoff — 2026-09-01 12:56

Arbeitsverzeichnis: /Users/danielmartin/claude-terminal-panel

## Stand

Branch `feat/context-threshold`, HEAD `0f026b6`, **Arbeitsbaum sauber, gepusht** nach `origin`
(clementcopper). Zwei Commits: `efd1d90` die große Runde (32 Dateien, +1747/−1362), `0f026b6` ein
Markdown-Fix.

Drin ist: zweistufige Tabs (Gruppen über Terminals), Gruppen-Persistenz in `workspaceState` mit
kalten Tabs nach dem Reload, Ausbau des Custom-Command-Wegs samt vier Modulen und
`preloadHelp`, alle Icons auf SF Symbols. Reload ist durch, Daniel hat es angesehen: **passt.**

Details in `CHANGELOG.md` unter `[Unreleased]` und in `README.local.md` („Tab groups", „Icons").

## Mitten drin

Nichts Angefangenes. Eine offene Entscheidung: das Resume-Icon trägt 48,0 Tinte gegen 36,5
(Continue) und 35,0 (Restart). Falls es zu schwer wirkt, in `scripts/render-icons.sh` die
Punktgröße für `clock.arrow.circlepath` von 36 auf ~32 setzen und neu rendern.

## Nächster Schritt

Offen — es liegt keine angefangene Arbeit an. Wenn die Runde nach `main` soll:
`git checkout main && git merge feat/context-threshold`.

## Schon probiert, geht nicht

- **SF Symbols als SVG geht nicht.** AppKit rastert beim Zeichnen (`/Im1 Do` im exportierten PDF),
  und `SFSymbolsFallback.otf` nennt seine Glyphen `uniXXXXXX` — die Zuordnung Name → Codepoint
  steht in keiner Plist, CoreText löst sie zur Laufzeit auf. Deshalb PNG in 3x, erzeugt von
  `scripts/render-icons.sh`. Nicht nochmal suchen.
- `clock.arrow.trianglehead.counterclockwise.rotate.90` existiert unter macOS 13 nicht (SF Symbols
  7). Verfügbarkeit hängt am OS, nicht an der installierten SF-Symbols-App.
- Kein PDF→SVG-Konverter auf der Maschine (`pdftocairo`, `mutool`, `inkscape`, `pdf2svg` fehlen).
- Codicons konnten es nicht lösen: in der eingefärbten Debug-Familie gibt es kein Symbol, das
  gleichzeitig eigenständig aussieht, ~60 Tinte trägt und sinnvoll „Resume" heißt.
- `` `X+\`` `` ist keine Markdown-Code-Spanne. Prettier bricht die Zeile danach so um, dass die
  Nachbar-Spannen zusammenlaufen. Für einen Backtick doppelte Backticks nehmen.

## Was Daniel entschieden hat

- Ein Gruppen-Tab = **eine CLI**. Das innere `+` fragt nicht mehr.
- Wiederhergestellte Tabs sind **kalt** — Prozess erst beim ersten Anklicken, wegen der Sessions.
- Gruppennamen aus dem cwd-Basename, **nie gekürzt**, Doppelklick zum Umbenennen.
- Icons: SF Symbols, SF Pro Medium, alle in Theme-Grau. **Gewicht geht vor Farbe.**
- `New Terminal with Custom Command` ersatzlos raus.

## Erledigt und vom Tisch

- Der Codicon-Weg für die Icons — mehrfach durchgemessen, verworfen.
- Eigene SVGs zeichnen und Claude-Orange als Icon-Farbe — beides angeboten, beides abgelehnt.
- Das fünfte Icon in der Titelleiste gehört VS Code (`…`-Überlauf bzw. Schließen), nicht uns.
- Ein eigener Branch `feat/terminal-groups` — angeboten, nicht genommen; alles liegt auf
  `feat/context-threshold`.
