# Handoff — 2026-11-13 09:31

Arbeitsverzeichnis: /Users/danielmartin/claude-terminal-panel

## Stand

Prozess-Monitor gebaut und installiert (1.2.0): jeder Bash-Aufruf von Claude erscheint als Chip in der
Form des Fortschritts-Chips, aufgeklappt mit den letzten Ausgabezeilen (8 Zeilen, read-only, ANSI-Farben).
Die Mod meldet die Aufrufe unter `shells` in `<tab>.live.json`, `src/shellWatcher.ts` liest Claude Codes
`tasks/<id>.output`, `media/shellChip.ts` zeichnet. Ein Aufruf, der eine Fortschrittsliste schreibt, zeigt
seine Ausgabe im aufgeklappten Fortschritts-Chip. Daniel hat neu geladen, mit einem Hintergrund-Zähler
getestet: „sieht gut aus“. Doku: `README.local.md` § Process monitor, Entscheidungen in
`Sessions/Fortschritt-Auftrag.md`.
HEAD: bb8a87e

## Nächster Schritt

Abnahme mit echtem `kuza check` (aus dem Handoff vom 12.11., noch offen): in einem Panel-Tab
`cd ~/Documents/DMA/Designdone/designdone-termin && node cli/kuza.mjs check --group logic --pause 5`
laufen lassen, Fortschritts-Chip aufklappen: Streifen, Fußzeile **und** die Ausgabe darunter müssen
erscheinen, kein eigener Chip für den kuza-Befehl. Ctrl-C muss nach ≤ 5 s „cancelled“ zeigen.
Ergebnis an `panel-verlauf-fortschritt-auftrag` melden. Erst Daniels Go holen (Akku, siehe unten).

## Danach (Auftrag)

- Projektliste `<cwd>/.claude/progress/*.json` lesen und zeigen (zuerst Bild, eingeklappt).
- „Was Claude gerade tut“ über Bash hinaus (Agenten, andere Tools) — erst fragen, ob der Monitor reicht.
- Figma Claude erst nach bewährtem VS-Code-Chip.

## Schon probiert, geht nicht

- `cat` über `tasks/*.output` aus einem Bash-Aufruf: liest die eigene Datei in sich selbst, 5 GB.
  Trigger `tasks-output-self-read` warnt jetzt.
- Probe-Serien und Browser-Renders ohne Daniels Go: Laptop ging zweimal am 13.11. aus (Akku leer, -60).
- Erste Layout-Runde ohne den Fortschritts-Chip im Bild: las sich als Ersatz (Memory `zusatz-neben-bestand-zeigen`).
- Render-Harness (`render.js`, `variants*.js`) lag im Scratchpad und ist weg; neu nach `scripts/probes/shell-chip.js`.

## Was Daniel entschieden hat

- Alles in `Sessions/Fortschritt-Auftrag.md` (13.11.: zusätzlich statt Ersatz, eigener Chip ohne Liste,
  jeder Vordergrund-Befehl sofort, Vordergrund-Chip geht mit Ende, Hintergrund bleibt bis ×).

## Erledigt und vom Tisch

- Layouts A (Chip je Aufruf), B (Sammel-Chip), C (unten angedockt) der ersten Runde: verworfen.
- Ob der Ausgabepfad gemessen ist: ja, E2E mit echtem `claude -p` und der Mod, Vorder- und Hintergrund.
