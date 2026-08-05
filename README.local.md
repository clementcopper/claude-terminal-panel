# Lokaler Build

Fork von [Nolikzero/claude-terminal-panel](https://github.com/Nolikzero/claude-terminal-panel),
umbenannt auf `local.claude-terminal-panel-local`, damit der Marketplace ihn nicht überschreibt.
Ziel ist ausschließlich der eigene Rechner — kein Publish.

## Bauen und installieren

```sh
cd ~/claude-terminal-panel
export PATH="$HOME/.nvm/versions/node/v20.19.0/bin:$PATH"
npm ci
npm run lint && npm run compile
npm run package
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --install-extension claude-terminal-panel-local-darwin-arm64-1.0.10.vsix
```

Danach VS Code neu starten.

## Zwei Fallen

**Node 20 ist nötig.** `vsce` 3.9.2 sammelt unter Node 25 null Dateien und meldet dann
`Extension entrypoint(s) missing`, obwohl `dist/extension.js` existiert. Die Meldung zeigt auf
die falsche Ursache.

**Kein Rebuild bei VS-Code-Updates.** `node-pty` 1.1.0 ist N-API: die Binaries exportieren
`napi_register_module_v1` und sind damit unabhängig von der Node-ABI. Gemessen — dasselbe
`pty.node` lädt unter ABI 115, 141 und 146. `@electron/rebuild` und `node-abi` sind deshalb aus
den devDependencies entfernt, ebenso das `postinstall`-Skript.

## Paketinhalt

`node-pty` lädt sein Binary ausschließlich aus `build/Release`, `build/Debug` oder
`prebuilds/<platform>-<arch>` (`node_modules/node-pty/lib/utils.js`), und `spawn-helper` muss
im selben Verzeichnis wie das geladene `pty.node` liegen. Alles andere ist über `.vscodeignore`
ausgeschlossen — Windows-Prebuilds, `bin/`, Quellen, `deps/`, `third_party/`.

Prüfen:

```sh
unzip -l *.vsix | grep -E "node-pty.*(\.node|spawn-helper)"
```

Erwartet: `build/Release/pty.node` und `build/Release/spawn-helper`, dazu dieselben zwei unter
`prebuilds/darwin-arm64/`. Kein `win32-*`, kein `bin/`.

## Unterschiede zum Original

| Bereich | Änderung |
|---|---|
| Tab-Tooltip | zeigt das Arbeitsverzeichnis, weil Claude Code seine Session-Historie pro Verzeichnis ablegt |
| Titelleiste | „Resume Session in Current Tab…" und „Continue Last Session in Current Tab" — starten den **aktiven** Tab mit `--resume` / `--continue` neu, im eigenen cwd des Tabs |
| Befehle | „New Terminal Tab (Continue Last Session)" und „(Resume Session…)" — dieselben Flags, aber in einem **neuen** Tab; nur über die Command Palette |
| `claudeTerminal.cwd` | festes Arbeitsverzeichnis, unabhängig vom geöffneten Ordner; `~` erlaubt |
| `claudeTerminal.preloadHelp` | Vorgabe `false`. An probiert der Start acht CLI-Binaries mit `--help` durch |
| Help-Ermittlung | ohne `shell: true`, Kommandoname muss `^[A-Za-z0-9._@/-]+$` erfüllen |
| Datei-Links | Pfade außerhalb von Workspace und Terminal-cwd fragen vor dem Öffnen nach |
| Nonce | `crypto.randomBytes` statt `Math.random` |
