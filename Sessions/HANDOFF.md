# Handoff — 2026-08-30 09:22

Arbeitsverzeichnis: /Users/danielmartin/claude-terminal-panel

## Stand

Branch `feat/context-threshold`, Arbeitsbaum sauber, HEAD `cf31062`. Sechs Commits dieser Sitzung:
Sidecar-Schicht entfernt (`d4bfe1f`), Limits-Speicher und Statusleiste repariert (`a97d421`,
`95efd7c`), Tab-Start auf Messung umgestellt (`0317d57`), Exit-Meldungen abgeräumter PTYs
unterdrückt (`9bcb13c`), Startanzeiger plus Erst-Byte-Messung (`cf31062`). Die `.vsix` ist gebaut
und installiert; Repo- und Installations-Hashes stimmten zuletzt überein. **Der Window-Reload
steht noch aus** — bis dahin läuft im Panel das alte Bundle, und keine der letzten drei
Änderungen ist im echten Betrieb gesehen worden.

## Mitten drin

- Nach dem Reload manuell prüfen: dreimal ein Tab öffnen (keine `[Process exited …]`, kein
  umgebrochener erster Frame), „Resume/Continue in current tab" (kein 129er), Panel in die andere
  Seitenleiste ziehen (Tabs kommen wieder, Sitzungen leben), OpenCode-Tab (Anzeiger läuft ~5 s),
  Claude-Tab (Anzeiger darf nicht aufblitzen).
- Danach in Ansicht → Ausgabe → **Claude Terminal** die Zeilen `first output after N ms` je Engine
  ablesen; die Zahlen gehören in `LEARNINGS.md`, falls sie von 5,1–5,4 s / <1 s abweichen.
- Nicht committet, aber offen: nichts. Prüfskripte liegen im Scratchpad
  (`harness2.html`, `verify2.py`, `spinner.py`, `boot2.js`, `retired.js`) — beim nächsten Bedarf
  aus `LEARNINGS.md` → „Prüfwerkzeuge für dieses Repo" neu aufbauen.

## Nächster Schritt

Fenster neu laden (Cmd+Shift+P → „Developer: Reload Window"), dann die fünf Punkte aus
„Mitten drin" durchgehen. Reload killt die Panel-Session — vorher nichts Ungesichertes offen haben.

## Schon probiert, geht nicht

- **Warmer `opencode serve` + `attach`:** gemessen 4,0–4,2 s gegen 5,3 s, also nur 1,3 s Gewinn;
  dafür Dauerprozess plus unauthentifizierter lokaler Endpunkt. Verworfen, nicht erneut aufrollen.
- **Ein laufender Server beschleunigt `opencode` pur nicht** — ohne `attach` startet das TUI seinen
  eigenen (gemessen: 5,1–5,4 s mit und ohne laufenden Server).
- **Zwei RAFs reichen nicht**, um die Terminalgröße vor dem Melden zu stabilisieren; die
  Statuszeile ändert die Höhe danach. Es braucht den 80-ms-Timer, den jeder Fit neu startet.
- **Zeitfenster statt Instanzvergleich** für Exit-Meldungen: das war die Ursache des 129ers,
  nicht die Lösung.

## Was Daniel entschieden hat

- Sitzungen überleben einen Webview-Neuaufbau (kein `killAll` mehr an `onDidDispose`); der
  verlorene Scrollback wird in Kauf genommen.
- Der Diagnose-Output-Channel bleibt dauerhaft drin, nicht nur zur Fehlersuche.
- `Session 0% (Credits)` statt nackter Null bei erschöpftem Wochenlimit — kostet 48 px, die Zeile
  wrappt dadurch ab 424 px statt 376 px.

## Erledigt und vom Tisch

- Sidecar-Architektur samt `ipc.ts`, `esbuild.sidecar.js` und `claudeTerminal.useSidecar` — gelöscht.
- Die Vermutung, die Statusbar bekomme keine Daten: sie bekam sie, `Session 0%` war korrekt.
