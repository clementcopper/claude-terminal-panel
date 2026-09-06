# Handoff — 2026-09-06 11:02

Arbeitsverzeichnis: /Users/danielmartin/claude-terminal-panel

## Stand

Drei Review-Runden (05./06.09.) sind auf `origin/main` bis `0aab09f`: Julians PR #1 portiert und
geschlossen, ~40 Befunde aus Host, Webview und Packaging behoben, Version 1.2.0, drei Probes unter
`scripts/probes/` (`npm run probe`, `npm run probe:ui`). Build 1.2.0 ist installiert; der letzte
Reload war vor Runde 3 (`fb430e4..0aab09f` noch ungesehen im Panel). Arbeitsbaum sauber.

## Mitten drin

- Nichts halb. Runde-3-Handtests stehen aus (Rename nach Pill-Flackern, zwei schnelle `+`, Link
  ohne Workspace-Ordner).

## Nächster Schritt

Fenster neu laden, dann:

```sh
cd ~/claude-terminal-panel && npm run probe && npm run probe:ui
```

Danach die drei Handtests aus CHANGELOG.md § 1.2.0 Fixed (letzte Zeilen).

## Schon probiert, geht nicht

- Tab aus xterm heraus führt nie in die Tab-Leiste; xterm nimmt die Taste. Befehle bleiben der Weg.
- `git merge-tree --merge-base` gibt es in git 2.39 nicht; Cherry-Picks per `git apply --check`.
- `git checkout <datei>` nach einem sed-Probe-Edit nimmt uncommittete Arbeit mit (ist mir passiert).

## Was Daniel entschieden hat

- Upstream vernachlässigen, Refactors nach Nutzen (Memory `upstream-vernachlaessigen`).
- Web-Links über `vscode.env.openExternal`; Version 1.2.0; alle Findings umsetzen, auch die UI.
- Nicht gemacht, bewusst: Linux-`/tmp`, `release.yml`, CSS-Fallback-Vereinheitlichung,
  Major-Updates (eslint 10, typescript 7).

## Erledigt und vom Tisch

- PR #1 geschlossen mit Kommentar; Branch `pr-1` liegt lokal noch, `git branch -D pr-1` räumt ihn.
- Artifact mit Bildern: https://claude.ai/code/artifact/98aac7b7-314b-4c93-bf4f-aebdf5deb34a
