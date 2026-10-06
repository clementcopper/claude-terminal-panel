/**
 * Type-checks the panel-bridge mod against the declarations Claude Code wrote beside it.
 *
 * The engine lays `.claude-plugin/types/` (its API, the built-in tools, the connected MCP tools
 * and a tsconfig) into the mod folder at every load from `CLAUDE_CODE_PLUGIN_DIRS`. A fresh clone
 * has none until a Claude tab has run once in the panel, so this is a separate script rather than
 * part of `typecheck`: it says what is missing and exits 0, instead of failing `vscode:prepublish`
 * on a machine that has not opened the panel yet.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MOD = path.join(ROOT, 'resources', 'mods', 'panel-bridge');
const types = path.join(MOD, '.claude-plugin', 'types', 'tsconfig.json');

if (!fs.existsSync(types)) {
  console.log(
    `typecheck:mod skipped — ${path.relative(ROOT, types)} is missing. Claude Code writes it when it loads the mod: open a Claude tab in the panel once, or run\n  claude --plugin-dir ${path.relative(ROOT, MOD)} -p 'ok'`
  );
  process.exit(0);
}

const tsc = path.join(ROOT, 'node_modules', '.bin', 'tsc');
const result = spawnSync(tsc, ['--noEmit', '-p', MOD], { stdio: 'inherit' });
process.exit(result.status ?? 1);
