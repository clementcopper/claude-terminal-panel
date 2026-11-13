# Auftrag: Verlauf und Fortschritt im Panel

Von der code-claude-Session in `~/Documents/DMA/Designdone/designdone-termin`, 12.11.2026, mit Daniels Freigabe
(Plan `~/.claude/plans/ok-weiter-geht-es-wise-torvalds.md`). Diese Datei ist das Einzige, was jene Session in
diesem Repo angefasst hat; sie ist nicht committet.

Kennzeichnung: **[gemessen]** = in jener Session ausgeführt und abgelesen · **[gelesen]** = am Code oder an der
Doku gelesen · **[Agent]** = ein Lese-Agent belegt es mit Datei, nicht nachgelesen · **[erschlossen]** = gefolgert,
nie gelaufen.

## Anlass

Am 12.11.2026 lief in einem Panel-Tab `kuza check`, der Sammelbefehl des Prüfsystems von KuZa: 28 Läufe
nacheinander, 12:12 bis 12:40. Daniel danach: „es gibt für mich keine Möglichkeiten, Verlauf und Fortschritt zu
sehen“, und ob man dazu etwas ins Panel einbauen kann.

Auf die Frage, was er sehen will, hat er drei von vier Punkten gewählt (12.11.2026):

1. **Laufender Check.** Während `kuza check` läuft: welcher Lauf dran ist, was schon grün, rot oder blockiert ist,
   wie lange noch.
2. **Stand des Auftrags.** Die zwölf Schritte der KuZa-Absicherung: was gebaut ist, was läuft, was offen ist.
   Heute steht das nur in Handoff und Bericht.
3. **Was Claude gerade tut.** Allgemein, nicht nur bei kuza: bei langen Arbeitsgängen sehen, an welchem Teil die
   Session ist und was schon erledigt ist.

Nicht gewählt: der Verlauf früherer Checks über Tage.

## Was heute ist

- Die Session, in der der Check lief, ist ein Tab dieses Panels (VS Code, nicht Figma Claude). Ein Bash-Aufruf
  darin erbt `CLAUDE_PANEL_TAB_ID`, `CLAUDE_PANEL_STATUS_DIR` und `MY_TAB_ID` [gemessen]. Ein Programm, das Claude
  startet, kennt also seinen Tab und den Status-Ordner des Fensters.
- `<tab>.live.json` trägt den Jetzt-Zustand und genau ein Werkzeug: `"state":"busy"`, `"tool":{"name":"Bash",
"summary":"<Beschreibung des Aufrufs>","startedAt":…}`, `"agents":0` [gemessen, Datei gelesen, nicht die
  Anzeige]. Bei einem Aufruf von 28 Minuten steht dort 28 Minuten dasselbe.
- Ob der Check im Vordergrund oder als Hintergrund-Aufruf lief, ist nicht mehr festzustellen. Bei einem
  Hintergrund-Aufruf endet der Tool-Aufruf sofort; dann stünde gar nichts da [erschlossen].
- Das Panel hat keinen Bereich für eine Liste und keinen Verlauf auf der Platte; jede Statusdatei wird bei jedem
  Schreiben ersetzt. Einziger Eingang von außen sind Dateien: kein Socket, kein URL-Schema [Agent].
- `kuza check` meldet `start <id>` und `green <id> 48 s` nur nach stderr und schreibt je Lauf ein Log in einen
  Temp-Ordner (`designdone-termin/cli/runner.ts`, `cli/kuza.mjs`) [gelesen]. Solange der Aufruf läuft, kommt davon
  nichts bei Daniel an.

## Was sichtbar werden soll

Anforderungen, kein Layout. Das Layout entscheidet Daniel am Bild (siehe „Fragen an Daniel“).

**Laufender Check**

- wie viele Läufe von wie vielen fertig sind, und welcher gerade läuft
- je Lauf sein Zustand: wartet, läuft, grün, rot, blockiert, Befund
- Laufzeit des Checks und des laufenden Laufs; erwartete Restzeit, wenn die Quelle eine nennt
- die Pause zwischen zwei Läufen (der Check wartet, solange macOS die CPU wegen Hitze drosselt), damit eine Pause
  nicht wie ein Hänger aussieht
- bei Rot die Notiz des Laufs und der Pfad zu seinem Log

**Stand des Auftrags**

- eine Liste, die den Lauf und die Session überlebt: zwölf Schritte, je erledigt, in Arbeit oder offen
- gehört zum Arbeitsverzeichnis, nicht zum Tab: jeder Tab der Gruppe zeigt dieselbe

**Was Claude tut**

- der Verlauf des laufenden Arbeitsgangs statt nur der letzten Zeile: jeder Tool-Aufruf mit seiner Beschreibung,
  seiner Dauer und seinem Ausgang
- Agenten mit ihrem Auftrag und ihrem Zustand, nicht nur ihre Zahl
- Hintergrund-Aufrufe (Bash und Agenten), solange sie laufen [dass sie heute aus der Zeile fallen: erschlossen,
  hier zu prüfen]

## Vorschlag: ein Vertrag, drei Quellen

Alle drei Punkte sind dieselbe Form: eine Liste mit Titel und Einträgen, jeder Eintrag mit Zustand. Eine Anzeige
für diese Form deckt alle drei; sie unterscheiden sich nur darin, wer schreibt und wie lange die Liste lebt.

| Quelle                         | Wer schreibt                                                                   | Gilt für               | Lebt                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------ | ---------------------- | ---------------------------------------------------------------------------------- |
| fremder Prozess (`kuza check`) | das Programm selbst, über die geerbten Variablen                               | den Tab                | bis zum Ende des Laufs, danach bis zur nächsten Liste oder bis Daniel sie schließt |
| Projekt (Stand des Auftrags)   | das Projekt, eine Datei oder ein Befehl dort                                   | das Arbeitsverzeichnis | über Sessions hinweg                                                               |
| Claude selbst                  | die Mod (`tool.call`, `turn.step`, `agent.spawn` kommen dort schon an [Agent]) | den Tab                | den Arbeitsgang                                                                    |

Entwurf des Formats für die ersten beiden Quellen. Ort, Name und Felder legt diese Session fest; der Entwurf sagt
nur, was die kuza-cli liefern kann:

```jsonc
{
  "v": 1,
  "id": "kuza-check", // mehrere Listen je Tab unterscheiden sich hierin
  "title": "kuza check",
  "state": "running", // running | done | failed
  "pid": 12345, // Prozess tot und state running = abgebrochen
  "startedAt": 1794484219373,
  "updatedAt": 1794484662071,
  "expectedSeconds": 1900, // optional, aus dem letzten vollständigen Lauf
  "detail": "/…/kuza-check-ab12", // optional, Ordner der Logs
  "items": [
    { "id": "test", "label": "test", "state": "ok", "seconds": 71 },
    { "id": "window", "label": "window", "state": "running", "startedAt": 1794484600000 },
    { "id": "height", "label": "height", "state": "pending" }
    // state: pending | running | ok | failed | blocked | info; dazu optional "note"
  ]
}
```

Was der Vertrag leisten muss, gleich wie er aussieht:

- **Ohne Panel kein Schaden.** Fehlen die Variablen, schreibt das Programm nichts und läuft wie heute.
- **Atomar geschrieben** (Temp-Datei und Umbenennen), wie `<tab>.json`.
- **Abbruch erkennbar.** Ein Check, der mit Ctrl-C oder einem Absturz endet, darf nicht ewig als laufend stehen.
- **Klein.** `kuza check` schreibt je Lauf zweimal (Start, Ende) und bei jeder Pause, also rund 60-mal in 30
  Minuten.
- **Für Agents lesbar.** Die kuza-cli bekommt `kuza status`, das dieselben Daten zeigt; die Datei ist dann die
  eine Quelle für Panel, Terminal und Agents.

## Grenzen in diesem Repo, die der Auftrag kennt

Aus `CLAUDE.md` [gelesen] und `.claude/rules/` [Agent]:

- Im Status-Ordner liegt keine `.json` außer Snapshots; der Watcher liest jede als Tab
  (`statusline-watcher.md`). Die Fortschritts-Datei braucht also einen anderen Namen oder Ort.
- Nachrichten-Verträge stehen doppelt (`src/types.ts`, `media/types.ts`), dazu `messageHandlers.ts` und die
  Karte in `media/main.ts`.
- Eine Zeile ein- oder ausblenden ändert die Terminalhöhe; danach xterm neu einpassen.
- Die Datei kommt von einem fremden Prozess und ist so wenig vertrauenswürdig wie Terminal-Ausgabe: Längen und
  Zahl der Einträge kappen, Text nie als HTML setzen, ein Pfad in `detail` öffnet nichts ohne Rückfrage.
- Die CSP ist `default-src 'none'`.
- Es gibt keine Test-Suite: eine Probe in `scripts/probes/`, einmal rot gezeigt.
- Ein Reload beendet die Sessions im Panel, also auch einen laufenden Check.

## Wer was liefert

**Diese Session (claude-terminal-panel)**

1. Den Vertrag festlegen: Ort, Name, Format, Lebensdauer; als Abschnitt in `README.local.md` neben „Writing your
   own producer“. Danach eine Nachricht an die designdone-termin-Session mit dem Abschnitt.
2. Die Anzeige für eine Liste dieser Form.
3. Den Verlauf der eigenen Tool-Aufrufe und Agenten aus der Mod, in derselben Anzeige.

**designdone-termin, sobald der Vertrag steht**

1. `kuza check` und `kuza run` schreiben die Datei (ein neuer `Io`-Eintrag neben `io.err`, gefüllt in
   `cli/runner.ts` bei Start, Ende und Pause; Test in `cli/runner.test.ts`).
2. `kuza status [--json]` liest sie.
3. Die Schrittliste des Auftrags als Datei im Repo, in der Form des Vertrags.

**Abnahme, gemeinsam.** Ein echter `kuza check --group logic` (vier Läufe, keine Mails, wenige Minuten) in einem
Panel-Tab, einmal im Vordergrund und einmal als Hintergrund-Aufruf, Daniel schaut zu. Ein grüner Test auf einer
der beiden Seiten ist keine Abnahme.

## Was Daniel entschieden hat

- 12.11.2026: Erst der Vertrag, dann die Anzeige. Vertrag v1 in `README.local.md` § Progress lists (a7966d6).
- 12.11.2026: Projektlisten liegen in `<cwd>/.claude/progress/<list id>.json`.
- 12.11.2026: Layout **A**: ein zweiter Chip unter dem Prompt-Chip, eine Zelle je Eintrag, Kopfzeile mit Titel,
  Zählung, Laufzeit und Restzeit, Fußzeile mit dem laufenden und dem roten Eintrag. Verworfen: Ring in der
  Statuszeile (B), Liste über der Statuszeile (C). Bilder: https://claude.ai/artifact/AsvznDFjpAnXTZUHWjMsGv
- 12.11.2026: Zustände von A abgenommen: Pause (❚❚, Pausenzeit, nächster Eintrag), fertig (Haken, Gesamtzeit,
  „27 grün · 1 rot“), abgebrochen (graues Quadrat, kein Rot). Bilder: https://claude.ai/artifact/3L2Eh6NWUxpfmiicMsh7Aj
- 12.11.2026: Ein fertiger oder abgebrochener Chip bleibt stehen, bis Daniel ihn schließt (× im Chip). Gewählt gegen
  „bis zum nächsten Prompt“ und „feste Zeit“; Kosten: 67 px je stehendem Chip.
- 12.11.2026: Erst nur das VS-Code-Panel; Figma Claude folgt, wenn sich der Chip mit einem echten `kuza check`
  bewährt hat.
- 12.11.2026: Der Chip startet eingeklappt (eine Zeile wie der Prompt-Chip, 27 px); ein Klick auf die Kopfzeile
  klappt ihn auf (Streifen und Fußzeile, 61 px), ein zweiter wieder zu. Das × gegen die Ziffern daneben ausgerichtet,
  1 px angehoben (3cdfcc5).
- 12.11.2026: Eingeklappt zeigt die Kopfzeile ein rotes „1 failed“; aufgeklappt nennt die Fußzeile die Läufe.
- 13.11.2026: Live-Ausgabe kommt **zusätzlich**, der Fortschritts-Chip bleibt wie er ist. Eingeklappt unverändert;
  aufgeklappt zeigt er unter Streifen und Fußzeile die Ausgabe des Prozesses („Prozess-Monitor“). Die ersten drei
  Layouts (https://claude.ai/artifact/PaJfVU55FWqtoksMmyEPYY) zeigten den Chip nicht und lasen sich als Ersatz.
- 13.11.2026: Ein Hintergrund-Aufruf ohne Fortschrittsliste (`npm test`) bekommt einen eigenen Chip in derselben
  Form: eingeklappt Befehl und Laufzeit, aufgeklappt die Ausgabe, kein Streifen.
- 13.11.2026: Auch **jeder Vordergrund-Bash** bekommt sofort einen Chip (gewählt gegen „ab 5 s“ und „nur
  Hintergrund“). Vordergrund-Aufrufe schreiben ihre Ausgabe ebenfalls live nach `tasks/<id>.output` [gemessen].
  Ein Vordergrund-Chip geht, wenn sein Befehl endet (sein Ergebnis steht im Terminal, die Datei löscht Claude Code);
  ein Hintergrund-Chip bleibt bis zum ×, wie ein Fortschritts-Chip. Bilder abgenommen:
  https://claude.ai/artifact/PaJfVU55FWqtoksMmyEPYY (Version 2).

## Fragen an Daniel (einzeln stellen)

- Wo im Panel steht die Liste? Zwei bis drei vollständige Layouts nebeneinander, aus der Formensprache der
  Statuszeile und der Prompt-Leiste, im Hauptzustand; danach kleine Schritte.
- Wie lange bleibt eine fertige Liste stehen: bis zum nächsten Prompt, bis er sie schließt, eine feste Zeit?
- Zieht Figma Claude (`~/figma-cli/swift-host`, gleicher Datei-Vertrag, eigene Kopie der Mod [Agent]) mit, oder
  bleibt es beim VS-Code-Panel?

## Hintergrund-Aufrufe: Live-Ausgabe (13.11.2026)

Daniel will die Ausgabe von Hintergrund-Aufrufen sehen, „in einer Art Terminal“. Plan
`~/.claude/plans/wir-haben-ja-k-rzlich-temporal-papert.md`: erst messen, dann 2–3 Layouts als Bild, dann bauen.

- Ein Hintergrund-Bash schreibt nach `/private/tmp/claude-501/<cwd mit - statt />/<session id>/tasks/<task id>.output`
  [gemessen, Claude Code 2.1.323]. Die Datei wächst live, stdout und stderr stehen gemischt in Schreibreihenfolge drin,
  den Befehl enthält sie nicht. Am Ende hängt Claude Code `[exited with code N]` an, die Datei bleibt danach stehen.
- Auch Vordergrund-Aufrufe legen dort kurz eine `.output` an und löschen sie wieder [gemessen: drei Dateien
  kamen und gingen]. Wer den Ordner beobachtet, sieht also mehr als nur die Hintergrund-Aufrufe.
- Die Mod sieht beim `tool.call` den Befehl, `description` und `run_in_background` (Eingabe), und im Ergebnis
  `backgroundTaskId`, dazu `backgroundedByUser` (Ctrl+B) und `timedOutAfterMs` (automatisch in den Hintergrund
  geschoben) [gelesen, Typen 2.1.323]. Ein Hintergrund-Agent liefert `status: "async_launched"`, `agentId`,
  `description` und `outputFile` [gelesen].
- Das Ende kommt als Turn mit `origin.kind: 'task-notification'` [gelesen]; die Exit-Zeile in der Datei reicht
  aber auch [gemessen].
- Damit ist die Zuordnung zum Tab lösbar: Die Mod läuft im Tab (`CLAUDE_PANEL_TAB_ID`) und kann je Aufruf
  `{ id, command, description, startedAt, outputFile }` in `<tab>.live.json` schreiben [erschlossen]. Den Pfad
  liefert die Schnittstelle für einen lokalen Bash nicht (`backgroundOutputPath` nur für entfernte); die Mod muss ihn
  aus `$.session.id()`, dem cwd und dem Temp-Ordner bauen. Das ist Claude Codes internes Layout und kann sich mit
  einem Update ändern; die Anzeige muss eine fehlende Datei als „Ausgabe nicht lesbar“ zeigen, nicht als leer.
- Nicht gemessen: was in der `outputFile` eines Hintergrund-Agenten steht (Transkript oder Text).

## Nicht geprüft

- Die Mod (`resources/mods/panel-bridge/hooks/register.ts`) wurde nur in Auszügen gelesen; was `tool.call` über
  Ausgang und Dauer eines Aufrufs liefert, ist offen.
- Ob Claude Codes eigene Aufgabenliste in der Mod ankommt. In der auftraggebenden Session gab es kein solches
  Werkzeug.
- Ob ein Hintergrund-Bash oder ein Hintergrund-Agent im Live-Snapshot stehen bleibt.
- Die Anzeige selbst: gelesen wurde die Datei, nicht das Bild im Panel. Auch die Breite der Seitenleiste bei
  Daniel ist nicht gemessen.
- Welche `.vsix` installiert ist.
