# Handoff — 2026-11-11 20:56

Arbeitsverzeichnis: /Users/danielmartin/claude-terminal-panel

## Stand

Zwei Fixes gebaut und installiert, Daniel hat noch nicht neu geladen:

1. Prompt-Leiste zeigt Skills und `!`-Zeilen wie getippt (`/code-review high`, `!npm test`);
   lokale Befehle (`/context`, `/color`, `/model`) lassen das Thema stehen. Mod nimmt den Text aus
   `prompt.submit` (composer/bridge) und `session.append` `<bash-input>` (`register.ts`, `S.typed`).
   Echter E2E-Lauf und Mod-Test (rot gegen alt) grün.
2. Umlaute beim Kopieren aus Panel-Tabs: PTY hatte keine Locale, Claude Codes `pbcopy` las UTF-8
   als Mac Roman (`Für` → `F√ºr`). `buildEnvironment` setzt `LANG=en_US.UTF-8`, falls keine Locale
   da ist (`src/ptyManager.ts`). Reproduziert, Probe alt `C` / neu `en_US.UTF-8`.
   Belege: LEARNINGS.md § Claude Code und § Live-Brücke, `.claude/rules/host.md`, `mods.md`.
   HEAD: 0c4939a

## Nächster Schritt

Daniel lädt das Fenster neu, startet einen frischen Tab und prüft:

- Text mit „ü § „…““ aus einem Tab kopieren, in anderen einfügen → keine `√º`.
- `/probe`-artiger Skill oder `!echo hi` → Leiste zeigt den getippten Befehl.

## Offene Punkte (bekannt, nicht beauftragt)

- Verdacht, ungeprüft: `turn.start` eines Subagenten (`agentId` gesetzt) könnte `S.prompt` mit
  dem Agent-Auftrag überschreiben; der Prompt-Zweig in `turn.start` prüft `agentId` nicht.
- `!` startet in Claude Code 2.1.319 einen eigenen Model-Turn (zweimal gemessen) — ob das immer so
  ist, unbekannt; ohne Turn erscheint die `!`-Zeile erst gar nicht in der Leiste.
- Aus Handoff 08.11. weiter offen: Reinstall schreibt „panel-bridge … reloaded“ in offene Tabs.

## Schon probiert, geht nicht

- `npx prettier --write` auf `resources/mods/panel-bridge/hooks/*.ts`: formatiert die ganzen
  Dateien um (Mod-Stil ohne Semikolons, war nie prettier-sauber). Mod-Dateien nicht prettieren.
- `rm` auf Scratchpad-Pfade mit `cd` davor verweigert der Safety-Check; neuen Ordner anlegen statt
  aufräumen.
- Escape vor Enter bei Slash-Befehlen in der PTY-Probe: unnötig, Enter führt den Befehl aus.

## Was Daniel entschieden hat

- Prompt-Leiste: Skills und `!` wie getippt, lokale Slash-Befehle nicht (09.11.).

## Erledigt und vom Tisch

- `<`-Heuristik bleibt nur als Fallback für Turns ohne `prompt.submit` (Notifications, Tests).
