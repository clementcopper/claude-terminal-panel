# Handoff — 2026-08-30 20:58

Arbeitsverzeichnis: /Users/danielmartin/claude-terminal-panel

## Stand

Branch `feat/context-threshold`, HEAD `43d9d0e`, Arbeitsbaum sauber. Fünf Commits: Terminal-Padding
links/rechts angeglichen und dann auf 8px gebracht, Model und Effort linksbündig, Ring-Level neu.
`.vsix` gebaut und installiert, Hashes stimmen. **Der Fenster-Reload fehlt noch** — im Panel läuft
der alte Extension-Host, keine der fünf Änderungen ist sichtbar.

Die Scrollbar-Frage ist beantwortet und abgeschlossen: Claude Code 2.1.251 nutzt den Alternate
Screen, damit gibt es kein Terminal-Scrollback und keinen Balken. Nicht reparierbar, Daniel
verzichtet darauf. Details in `LEARNINGS.md`.

## Mitten drin

- Nichts halb Gebautes. Offen ist nur der Reload und die Handprüfung danach.

## Nächster Schritt

Daniel bittet, `Developer: Reload Window` auszuführen (killt die Sitzungen in den Tabs), danach
von Hand prüfen:

1. Terminaltext links und rechts gleich weit vom Rand, ~8px bei 520px Panelbreite.
2. `Opus 5` und Effort-Badge auf derselben linken Kante.
3. Ctx-Ring orange ab 36% Fenster, rot ab 48% (bei Threshold 60); Session und Week ab 60/80%.
4. Comp-Ring: 2. Compaction orange, 3. rot — vorher immer blau.

## Schon probiert, geht nicht

- **Die Scrollbar per CSS sichtbar machen.** Das CSS war die ganze Zeit richtig, im Harness mit
  echtem Scrollback zeichnet es einen sauberen 10px-Balken. Es gibt schlicht nichts zu scrollen.
- **`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`** über `claudeTerminal.env` — funktioniert messbar
  (Balken 338px, `opacity 1`), von Daniel wieder zurückgestellt. `settings.json` ist Originalstand.
- **`overviewRuler: { width: 1 }`**, um FitAddons 14px-Rinne zu verkleinern — schaltet den
  Overview-Ruler scharf, der dann zeichnet. Gemessen.
- **Padding auf `.xterm`**, um den Text zu verschieben — `.xterm-viewport` ist absolut mit
  `inset: 0` gegen die Padding-Box, bewegt sich also nicht, und FitAddon zieht das Padding
  zusätzlich von der Spaltenzahl ab.
- **Brave headless mit `--screenshot` / `--dump-dom`** beendet sich nicht, auch nicht bei einer
  leeren Seite. Über `--remote-debugging-port` und CDP fahren, Treiber liegt im Scratchpad.
- **Artifact-URL und Datei-Karten** haben bei Daniel beide nichts angezeigt. Bilder auf den
  Schreibtisch legen war der Weg, der ankam (`~/Desktop/claude-altscreen.png`, `claude-inline.png`).

## Was Daniel entschieden hat

- Terminal-Scrollbar ist verzichtbar, Alternate Screen bleibt.
- Ring-Level auf der **Füllung**, nicht auf dem Rohprozentsatz: 60% orange, 80% rot.
- Comp-Ring zählt statt zu füllen: 2. Compaction orange, 3. rot, unabhängig vom Budget.
- Terminal-Padding 8px, passend zum `padding: 8px` der Statusleiste.
- Model und Effort linksbündig — kippt die Mittelachse aus `daca24f`.

## Erledigt und vom Tisch

- Ein neues Setting für den Alternate Screen — `claudeTerminal.env` kann das schon.
- Die eigene cols-Rechnung, um FitAddons Rinne loszuwerden. Wäre der einzige Weg zu exakt 8px in
  jeder Breite, kostet aber die Rinne und legt den Balken über die letzte Spalte.
- Das Figma-Design ist **nicht** nachgezogen, bewusst aufgeschoben; steht in der Memory
  `statusbar-design-in-figma` als Liste der Abweichungen.
