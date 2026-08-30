# Handoff — 2026-08-30 19:25

Arbeitsverzeichnis: /Users/danielmartin/claude-terminal-panel

## Stand

Branch `feat/context-threshold`, HEAD `84b0696`, Arbeitsbaum sauber. Die Statusleiste ist neu: vier 36px-Ringe statt Balken und Textzeile, Threshold
über eine InputBox, SF Mono im Terminal und in beiden Pfadzeilen, SF Compact Display sonst,
Terminal-Scrollbar wieder sichtbar. Dazu der Fensterwechsel-Bug — der Statusordner liegt jetzt
unter `status/<window token>/`, vorher löschten sich die Fenster gegenseitig die Snapshots. Zwölf Commits, `.vsix` gebaut und installiert, Hashes stimmen. Das Figma-Design ist nachgezogen (Memory
`statusbar-design-in-figma`).

## Mitten drin

- **Der Reload ist durch**, gegengeprüft: Extension-Host seit 13:52:48, Bundle von 13:49:17, und
  die Hashes von `extension.js`, `main.js` und `styles.css` stimmen mit dem Arbeitsbaum überein.
  Im Panel läuft der aktuelle Stand.
- Offen bleibt die Handprüfung, weil ein Standbild keinen Zeiger hat.

## Nächster Schritt

Von Hand im Panel durchgehen, in dieser Reihenfolge:

1. Stop im Hover — Scheibe `#EC1500`, Quadrat weiß.
2. Ctx-Ring im Hover — graue Scheibe erscheint, der Track ändert sich **nicht**.
3. Klick auf den Ctx-Ring — Eingabe öffnet, `0` und `120` müssen abgelehnt werden.
4. Terminal mit Scrollback — 10px-Balken sichtbar; ohne Scrollback keiner.
5. OS-Theme umschalten — `#FDA400` und `#EC1500` sind in beiden Modi derselbe Wert.

## Schon probiert, geht nicht

- **Fokusringe durch Löschen der Regeln entfernen** — Chromium malt dann seinen eigenen, lauter
  als der entfernte. Es braucht `outline: none` auf `:focus` **und** `:focus-visible`.
- **`min-width: 220px` glatt auf den Ringcontainer** — schlägt `max-width`, schnitt unter 236px
  den Comp-Ring ab, und `overflow: hidden` verbarg es. Jetzt `min(220px, 100%)`.
- **Die Ringe in einen eigenen Container** — der ist ein Flex-Element und bricht als Ganzes um,
  der Stop-Button blieb allein in Zeile 1. Sie müssen Geschwister der Zeile sein.
- **`butt`-Kappen am Comp-Ring**, um die Lücken sichtbar zu machen — bricht die Formsprache. Die
  Lücke stattdessen auf 21° ziehen, dann tragen runde Enden.
- **Warngelb auf 4,5:1 abdunkeln** (`#8A6200`) — wird braun. Siehe Memory
  `farbton-schlaegt-kontrastregel`.

## Was Daniel entschieden hat

- Kontrast ≥ 4,5:1 für neutralen Text, **nicht** für Warn und Danger — dort gewinnt der Farbton.
- Ring-Label und -Wert in einer Farbe, Hierarchie nur über das Gewicht (600 gegen 400).
- Keine Fokusringe in der Statusleiste, im Design wie im Build.
- Ctx-Zahl zählt gegen den Threshold und wird nicht bei 100 gedeckelt.
- Zustand „Credits" schaltet bei `sessionPercent >= 100`, nicht am Wochenlimit.

## Erledigt und vom Tisch

- **Zustand 9 (Guthaben in €)** — es gibt keine Datenquelle. `stats-cache.json` führt `costUSD`,
  im Abo überall 0; Transcripts und statusLine-Schema kennen kein Kosten- oder Guthabenfeld.
- **Tooltip-Zustand und Fokus-Zeile im Figma-Frame** — von Daniel gestrichen, nicht als Lücke
  führen.
- **Eine 180px-Spalte im Breiten-Frame** — Figmas Umbruch trifft die Stufe nicht; nur als Text.
