# Handoff — 2026-11-07 15:11

Arbeitsverzeichnis: /Users/danielmartin/claude-terminal-panel

## Stand

Sechs Panel-Features für Daniels parallele Sessions, alle gebaut, installiert, von Daniel im Panel
getestet: Bild-Links öffnen (`vscode.open`), umgebrochene Pfade klickbar (Claude bricht hart um,
`isWrapped` false), `/color` zufällig pro Tab ohne Dubletten + eigenes `/color` färbt mit,
Spinner + Laufzeit in der Statuszeile, Leiste über dem Terminal: `✻` + Haikus Zeile zur letzten
Antwort, darunter der letzte Prompt, in der Tabfarbe. Details: README.local.md § Status line
(Feldtabelle, „Run time and prompt bar“), LEARNINGS.md (Einträge vom 07.11.).
HEAD: 23f907d

## Mitten drin

- Nichts halb.

## Nächster Schritt

Nichts offen beauftragt. Wenn Daniel weitermacht, zuerst prüfen:

```sh
cd ~/claude-terminal-panel && npm run test:mod && npm run probe
```

## Offene Punkte (bekannt, nicht beauftragt)

- Prompt-Filter in `turn.start` ist eine Heuristik (leer oder beginnt mit `<` → kein Prompt). Sauberer
  wäre `prompt.submit` mit `origin.kind` (`composer` vs. `task-notification`, in den Mod-Typen) — nie
  live an einem echten Hintergrund-Task gesehen.
- Ein von Hand gesetztes `/color` kennt `PtyManager.sessionColorFor` nicht: neuer Tab kann dieselbe
  Farbe bekommen; Restart/Resume setzt die Panel-Farbe wieder. Daniel: „nicht schlimm“.
- Nach Fenster-Reload ist die Leiste leer bis zum nächsten Prompt (Mod-Zustand pro Prozess).

## Schon probiert, geht nicht

- Bare `/color` liefert dem `command.run`-Hook nur `{"ref":1}`, keinen Text — der Mod würfelt
  deshalb selbst und reicht `args` weiter. Text aus der gerenderten Zeile lesen (`ui.render`
  `CommandOutput`) nicht gebaut, ungetestet verworfen: alte Zeilen würden beim Scroll/Resume neu
  rendern und eine alte Farbe setzen können.
- Bash-Ausgabe live zeigen: der Mod bekommt kein Event mit Bash-Output (nur `ToolProgress`
  `background_hint`). Daniel wollte nur Zeit + Spinner.
- Ein-Zeilen-Variante der Leiste (Zusammenfassung · Prompt): bei 420 px bleibt „Bildpfade öff…“.

## Was Daniel entschieden hat

- Leiste: Variante C (getönte Fläche), Spinner und Zeit links vor dem Befehl, Zusammenfassung und
  Prompt zwei Zeilen in einer Fläche, `✻` in Claude-Orange `#d97757`.
- Zusammenfassung von Haiku (nicht ausgeschnitten), Ziel „schnell sehen, worum es geht und woran
  gearbeitet wird“.
- `/color` zufällig ohne Dubletten.

## Erledigt und vom Tisch

- Agent SDK: nicht genutzt und nicht geplant; die Extension fährt das echte `claude` im PTY.
- Varianten-Artifact: https://claude.ai/artifact/LBznUXDPmzcKCLwVeBatkZ (Version 5 = gebautes Bild)
