# Handoff — 2026-09-01 12:50

Arbeitsverzeichnis: /Users/danielmartin/claude-terminal-panel

## Stand

Branch `feat/context-threshold`, HEAD `2906212`. **Alles uncommittet**: 15 geändert, 4 gelöscht,
3 neue Pfade (`media/icons/`, `scripts/render-icons.sh`, `scripts/render-sf-symbol.swift`). Eine
große Runde: zweistufige Tabs (Gruppen über Terminals), Persistenz der Gruppen in
`workspaceState`, Ausbau des Custom-Command-Wegs, und alle Icons auf SF Symbols. Lint, beide
`tsc --noEmit` und `npm run package` sind grün; `.vsix` ist gebaut und installiert.

**Der Fenster-Reload fehlt.** Im Panel läuft der alte Extension-Host — nichts davon ist von Hand
geprüft. Details stehen in `CHANGELOG.md` unter `[Unreleased]` und in `README.local.md`
(Abschnitte „Tab groups" und „Icons").

## Mitten drin

- Handprüfung nach dem Reload, in dieser Reihenfolge: Gruppen anlegen/umbenennen/schließen →
  Fenster neu laden → kommen Gruppen mit Namen und Reihenfolge zurück, läuft **nur** der zuletzt
  aktive Tab, starten die anderen beim Klick? → `New Terminal (Resume Session…)` aus der Palette
  (der Pfad, der beim Custom-Command-Ausbau am ehesten mitgestorben wäre).
- Offene Designfrage: Resume trägt 48,0 Tinte gegen 36,5 (Continue) und 35,0 (Restart). Wenn es
  zu schwer wirkt, in `scripts/render-icons.sh` die Punktgröße für `clock.arrow.circlepath` von
  36 auf ~32 setzen und neu rendern.

## Nächster Schritt

`Cmd+Shift+P` → `Developer: Reload Window`, danach im Panel `claude --resume`.

## Schon probiert, geht nicht

- **SF Symbols als SVG geht nicht.** AppKit rastert beim Zeichnen (`/Im1 Do` im exportierten PDF),
  und `SFSymbolsFallback.otf` nennt seine Glyphen `uniXXXXXX` — die Zuordnung Name → Codepoint
  steht in keiner Plist. Deshalb PNG in 3x. Nicht nochmal suchen.
- `clock.arrow.trianglehead.counterclockwise.rotate.90` existiert unter macOS 13 nicht (SF Symbols
  7). Ersetzt durch `clock.arrow.circlepath`.
- Kein PDF→SVG-Konverter auf der Maschine (`pdftocairo`, `mutool`, `inkscape`, `pdf2svg` fehlen).
- Codicons konnten das Problem nicht lösen: in der eingefärbten Debug-Familie gibt es kein Symbol,
  das gleichzeitig eigenständig aussieht, ~60 Tinte trägt und sinnvoll „Resume" heißt.

## Was Daniel entschieden hat

- Ein Gruppen-Tab = **eine CLI**. Das innere `+` fragt nicht mehr, es öffnet die CLI der Gruppe.
- Wiederhergestellte Tabs sind **kalt** — Prozess erst beim ersten Anklicken, wegen der Sessions.
- Gruppennamen aus dem cwd-Basename, **nie gekürzt**, Doppelklick zum Umbenennen.
- Icons: SF Symbols, SF Pro Medium, alle in Theme-Grau. **Gewicht geht vor Farbe.**
- `New Terminal with Custom Command` ist ersatzlos raus, samt vier Modulen und `preloadHelp`.

## Erledigt und vom Tisch

- Der Codicon-Weg für die Icons — mehrfach durchgemessen, verworfen.
- Eigene SVGs zeichnen und Claude-Orange als Icon-Farbe — beides angeboten, beides abgelehnt.
- Das fünfte Icon in der Titelleiste gehört VS Code (`…`-Überlauf bzw. Schließen), nicht uns.
