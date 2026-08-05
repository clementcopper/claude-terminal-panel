# Learnings, Improvements & Dead Ends — claude-terminal-panel (lokaler Fork)

Nicht-offensichtliche Erkenntnisse und Sackgassen. Nur eintragen, was künftige Arbeit spart.

- **`vsce` wendet Negationen in `.vscodeignore` nach allen Ignore-Mustern an**, nicht in
  Zeilenreihenfolge. Ein pauschales `!node_modules/node-pty/**` holt deshalb das ganze Modul
  zurück, egal welche Ausschlüsse danach stehen. Richtig ist: alles ignorieren und dann genau
  die nötigen Pfade negieren. Ergebnis hier 15,64 MB → 608 KB.
- **`vsce` 3.9.2 sammelt unter Node 25 null Dateien** und meldet
  `Extension entrypoint(s) missing`, obwohl das Bundle existiert. Zeigt auf die falsche
  Ursache. Node 20 funktioniert. `vsce ls` gibt in dem Fall leere Ausgabe — daran erkennbar.
- **`vsce` liest zusätzlich die `.gitignore`.** Build-Ausgaben, die dort stehen, fallen aus dem
  Paket. Deshalb sind `dist/`, `media/main.js` und `media/xterm.css` dort bewusst *nicht*
  ignoriert, mit Begründung als Kommentar.
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
