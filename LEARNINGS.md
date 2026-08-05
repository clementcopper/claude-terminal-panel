# Learnings, Improvements & Dead Ends — claude-terminal-panel (lokaler Fork)

Nicht-offensichtliche Erkenntnisse und Sackgassen. Nur eintragen, was künftige Arbeit spart.

- **`vsce` wendet Negationen in `.vscodeignore` nach allen Ignore-Mustern an**, nicht in
  Zeilenreihenfolge. Ein pauschales `!node_modules/node-pty/**` holt deshalb das ganze Modul
  zurück, egal welche Ausschlüsse danach stehen. Richtig ist: alles ignorieren und dann genau
  die nötigen Pfade negieren. Ergebnis hier 15,64 MB → 608 KB.
- **`vsce` 3.9.2 sammelt unter Node 25 null Dateien** und meldet
  `Extension entrypoint(s) missing`, obwohl das Bundle existiert. Zeigt auf die falsche
  Ursache. Node 20 funktioniert. `vsce ls` gibt in dem Fall leere Ausgabe — daran erkennbar.
- **`vsce` liest die `.gitignore` NICHT, solange `.vscodeignore` existiert.** Gemessen mit vsce
  3.9.2: `dist/` in `.gitignore` eingetragen, `vsce ls` listet `dist/extension.js` weiterhin.
  Die frühere Notiz hier behauptete das Gegenteil — sie war falsch. Folge: was nicht ins `.vsix`
  soll, braucht eine Zeile in `.vscodeignore`; ein `.gitignore`-Eintrag genügt nicht (ein
  Screenshot im Projektordner landete so im Paket). Umgekehrt wäre `.gitignore` erst wieder
  zuständig, wenn `.vscodeignore` gelöscht würde — dann fielen die Build-Ausgaben aus dem Paket.
- **`.git/info/exclude` löst den Konflikt zwischen `git status` und `vsce`.** Build-Ausgaben
  dürfen nicht in `.gitignore` (sonst fehlen sie im Paket), stehen dort aber dauerhaft als
  untracked herum. Ein Eintrag in `.git/info/exclude` blendet sie nur lokal aus; `vsce` liest
  diese Datei nicht. Geprüft: `vsce ls` listet `dist/extension.js`, `media/main.js` und
  `media/xterm.css` danach weiterhin, 56 Dateien insgesamt.
- **`node-pty` 1.1.0 ist N-API** (`napi_register_module_v1`), also ABI-unabhängig. Kein Rebuild
  bei VS-Code-Updates, `@electron/rebuild` und `node-abi` sind überflüssig. Belegt: dasselbe
  `pty.node` lädt unter Node-ABI 115, 141 und 146.
- **Ein direkt gestartetes Electron (`ELECTRON_RUN_AS_NODE=1`) kann fremde `.node`-Dateien nicht
  laden**: „mapping process and mapped file (non-platform) have different Team IDs". Library
  Validation greift, im echten Extension-Host nicht. Diese Methode taugt also **nicht** für
  ABI-Tests — stattdessen dieselbe Datei unter mehreren Node-Versionen aus nvm laden.
- **Der Loader sucht nur in `build/Release`, `build/Debug`, `prebuilds/<platform>-<arch>`**
  (`node_modules/node-pty/lib/utils.js`) und erwartet `spawn-helper` **im selben Verzeichnis**
  wie das geladene `pty.node`. `@electron/rebuild` legt sein Ergebnis dagegen unter
  `bin/<platform>-<arch>-<abi>/node-pty.node` ab — wird nie geladen.
- **Claude Code speichert Session-Historie pro Arbeitsverzeichnis** unter
  `~/.claude/projects/<pfad>/`. Ein Panel, das im falschen Ordner startet, zeigt eine leere
  `/resume`-Liste, ohne dass etwas defekt ist. Deshalb Tooltip mit cwd und die Einstellung
  `claudeTerminal.cwd`.
- **`xterm.css` malt den Viewport `#000`** (`.xterm .xterm-viewport`, Zeile 93 — Workaround für
  deckende macOS-Scrollbalken). Die Zellen färbt xterm aus seinem Theme, diese Fläche nicht.
  `FitAddon` rechnet ganze Zeilen, also blieb der Rest unter der letzten Zeile als schwarzer
  Balken sichtbar, sobald die Polsterung des Wrappers wegfiel. Override gehört in `styles.css`:
  `media/xterm.css` wird bei jedem `npm run compile` neu aus `node_modules` kopiert.
- **`opacity` auf einem Element dimmt seine Kinder mit.** Eine Fortschrittsspur mit
  `opacity: 0.25` und einer Füllung in derselben Farbe wirkt deshalb komplett leer — die Füllung
  erbt die 25 %. Spur und Füllung brauchen eigene Farben, nicht eine Farbe plus Opacity.
- **`direction: rtl` für eine Ellipse links kehrt reine ASCII-Pfade um**: `~/claude-terminal-panel`
  erschien als `claude-terminal-panel/~`, weil `/` und `~` bidirektional neutral sind. Kürzen im
  Code ist verlässlicher als der CSS-Trick.
- **xterm-Themes sind eine Momentaufnahme, keine CSS-Bindung.** `theme` nimmt fertige Farbwerte,
  also folgt das Terminal einem VS-Code-Themewechsel nur, wenn man die Werte neu setzt. Ein
  `MutationObserver` auf `class`/`style` von `<html>` und `<body>` reicht: VS Code schreibt die
  `--vscode-*`-Variablen schon beim Durchblättern im Theme-Picker um, entprellen ist deshalb
  nötig.
- **Claudes eigene Farben folgen dem Terminal-Theme nicht.** Diff-Blöcke und Hervorhebungen
  kommen als absolute Truecolor-Sequenzen aus dem CLI, passend zu Claudes `theme`-Einstellung —
  ohne Eintrag in `~/.claude/settings.json` ist das die dunkle Vorgabe. Auf einem hellen
  VS-Code-Theme ist das Ergebnis unlesbar, und die Extension kann es nicht beheben: sie belegt
  nur Hintergrund, Vordergrund und die 16 ANSI-Slots. Gegenmittel ist Claudes eigenes Theme
  (`/theme`); eine ANSI-basierte Variante würde die Werte der Extension mitnutzen. Im PTY steht
  kein `COLORFGBG`, Claude bekommt also auch keinen Hinweis auf hell/dunkel.
