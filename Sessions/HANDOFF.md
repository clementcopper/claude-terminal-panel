# Handoff — 2026-11-12 14:07

Arbeitsverzeichnis: /Users/danielmartin/claude-terminal-panel

## Stand

Auftrag „Verlauf und Fortschritt im Panel“ (`Sessions/Fortschritt-Auftrag.md`, alle Entscheidungen dort unter
„Was Daniel entschieden hat“). Gebaut: Tab-Listen. Programme in einem Tab schreiben
`$CLAUDE_PANEL_STATUS_DIR/progress/<tab>/<list>.json` (Vertrag v1: `README.local.md` § Progress lists),
`src/progressWatcher.ts` liest sie, `media/progressChip.ts` zeichnet je Liste einen Chip unter dem Prompt-Chip.
Der Chip startet eingeklappt (27 px, rotes „N failed“), Klick auf die Kopfzeile klappt ihn auf (61 px), × schließt
fertige oder abgebrochene Listen. Installiert, Daniel hat noch nicht neu geladen (Extension-Host von 11.11. 15:18).
Die kuza-Session (designdone-termin, Name `panel-verlauf-fortschritt-auftrag`) schreibt schon echte Dateien. Beide
lesen sich mit dem Parser fehlerfrei.
HEAD: a313888

## Nächster Schritt

Daniel lädt das VS-Code-Fenster neu. Dann Abnahme: in einem Panel-Tab
`cd ~/Documents/DMA/Designdone/designdone-termin && node cli/kuza.mjs check --group logic --pause 5` laufen lassen,
einmal im Vordergrund, einmal als Hintergrund-Bash. Chip zu und auf ansehen, ein Ctrl-C-Abbruch muss nach ≤ 5 s
„cancelled“ zeigen. Ergebnis an `panel-verlauf-fortschritt-auftrag` melden.

## Danach (Auftrag, jeweils erst Bild, dann Bau)

- Projektliste `<cwd>/.claude/progress/*.json` lesen und zeigen (echte Datei: designdone-termin
  `.claude/progress/kuza-absicherung.json`, 12 Schritte). Vorschlag zuerst eingeklappt (Memory
  `zusatzanzeigen-eingeklappt`).
- „Was Claude gerade tut“ aus der Mod (`tool.call`, `agent.spawn`), gleiche Chip-Form.
- Figma Claude erst nach bewährtem VS-Code-Chip.

## Schon probiert, geht nicht

- `hidden` auf Streifen/Fußzeile: `display: flex` gewinnt, Chip blieb 58 px. Jetzt `.collapsed`-Regel.
- × als Schriftzeichen: hängt an der Grundlinie. Gezeichnet, 1 px angehoben, ausgerichtet an den Ziffern daneben.
- Render-Harness für Bilder: Scratchpad `progress-layouts/` (`render.js`, `variants.js`, `ink.py`) ist morgen weg;
  bei Bedarf neu nach dem Muster in `scripts/probes/progress-chip.js` aufbauen.

## Was Daniel entschieden hat

- Alles in `Sessions/Fortschritt-Auftrag.md` eingetragen. UI-Texte englisch (Repo-Regel), Daniel hat die Bilder so gesehen.

## Erledigt und vom Tisch

- Layout B (Ring) und C (Liste über der Statuszeile) verworfen.
- Fragen der kuza-Session zum Vertrag (detail relativ, Abbruch, blocked) beantwortet, in README und ihrer `docs/kuza-qa.md`.
