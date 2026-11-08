# Handoff — 2026-11-08 14:48

Arbeitsverzeichnis: /Users/danielmartin/claude-terminal-panel

## Stand

„Continue Last Session in Current Tab“ ist repariert: `/color` lief in `session.start` und legte
für jeden Tab ohne Prompt ein Transkript an, das `claude --continue` dann öffnete. Jetzt läuft
`/color` erst beim ersten echten Prompt (`turn.start`, über `$.clock.after`), Claudes Rahmen färbt
sich nach der ersten Antwort, die Panel-Leiste sofort. Reproduziert und nach dem Fix wiederholt
(node-pty, `scratchpad/repro-continue/run.js`). Installiert; Daniel hat noch nicht neu geladen und
„Continue“ gedrückt. Leere Farb-Sessions aufgeräumt (6 Dateien im Papierkorb). Davor (07.11.):
Bild-Links, umgebrochene Pfade, `/color` pro Tab, Spinner + Laufzeit, Prompt-Leiste mit
Haiku-Zeile — Details in README.local.md § Status line und LEARNINGS.md.
HEAD: 893b4cd

## Nächster Schritt

Daniel lädt das Fenster neu und drückt in einem Tab „Continue Last Session“ — erwartet: die letzte
echte Session. Falls nicht, zuerst das neueste Transkript des Verzeichnisses ansehen:

```sh
ls -t ~/.claude/projects/-Users-danielmartin-claude-terminal-panel/*.jsonl | head -3
```

## Offene Punkte (bekannt, nicht beauftragt)

- Noch liegen gelassen, weil gerade beschrieben: leere Farb-Sessions `4df8bbfd` (`~/.claude`) und
  `84ecac59` (designdone-termin). Verschwinden aus „Continue“, sobald dort eine echte Session neuer ist.
- Eine Neuinstallation der Extension schreibt „panel-bridge … reloaded“ in offene Tabs → auch das
  legt für Tabs ohne Prompt ein Transkript an (nur beim Entwickeln).
- Prompt-Filter in `turn.start` ist eine Heuristik (`<`); `prompt.submit` mit `origin.kind` wäre sauber.
- Global geschrieben, für die nächste CTO-Session: `~/.claude/LEARNINGS.md` (§ Cause only after
  reproduction) und `~/.claude/rules/working-rules.md` (Zeile „A null result from a nested tool…“).

## Schon probiert, geht nicht

- Reproduktion mit einem Test-Claude aus dieser Session schrieb nie ein Transkript: er erbt
  `CLAUDE_CODE_CHILD_SESSION` („Transcript saving is off“). Session-Variablen aus der Env löschen.
- `$.command.run` direkt im `turn.start`-Hook: laut API-Doku verweigert, solange der Turn auf den
  Hook wartet — daher `$.clock.after`.

## Was Daniel entschieden hat

- Leere Sessions in den Papierkorb (Finder, „Zurücklegen“ möglich), nicht löschen.

## Erledigt und vom Tisch

- `db22c1a7` (designdone-de, nur Reload-Meldungen) im Papierkorb; „Continue“ dort öffnet `ebe0e90b`.
