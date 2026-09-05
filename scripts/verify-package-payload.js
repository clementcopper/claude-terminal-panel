/**
 * Guards the native payload of the .vsix.
 *
 * Two failures cost a full build-install-reload cycle each before this existed:
 *
 * 1. The package carried only one architecture's prebuild. `node-pty`'s loader picks the
 *    directory from `process.arch` (`lib/utils.js`), so on the other machine it dies with
 *    "Cannot find module './prebuilds/<arch>//pty.node'".
 * 2. `spawn-helper` shipped without its executable bit. `npm ci` leaves it at 644 —
 *    `node-pty`'s own `scripts/post-install.js` never chmods it — and `vsce` copies the mode
 *    into the archive verbatim. `pty.node` then loads fine and every spawn fails with
 *    "posix_spawnp failed", which points nowhere near the cause.
 *
 * Both are invisible until the extension actually runs, and only on the machine that lacks
 * the right file. Hence a check on both sides of packaging:
 *
 *   --source   fix the modes in node_modules, then assert every prebuild is complete
 *   --vsix     assert the archive really carries them, with the right modes
 *
 * Plain CommonJS on the Node standard library: this runs from an npm script, before and after
 * `vsce`, and must not depend on anything the packaging step could remove.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PREBUILDS = path.join(ROOT, 'node_modules', 'node-pty', 'prebuilds');
const BUILD_RELEASE = path.join(ROOT, 'node_modules', 'node-pty', 'build', 'Release');

/**
 * What each platform actually loads at runtime. The Windows list is not decoration:
 * `lib/windowsPtyAgent.js` reaches for `conpty` or `pty` depending on `useConpty`,
 * `lib/conpty_console_list_agent.js` for `conpty_console_list`, and the `conpty/` pair is the
 * DLL variant behind `useConptyDll`. Debug symbols (*.pdb) are deliberately absent — they are
 * ~95 % of the 58 MB those two directories occupy and nothing loads them.
 */
const WINDOWS_FILES = [
  'pty.node',
  'conpty.node',
  'conpty_console_list.node',
  'winpty.dll',
  'winpty-agent.exe',
  'conpty/conpty.dll',
  'conpty/OpenConsole.exe'
];

const REQUIRED_PREBUILDS = {
  'darwin-x64': ['pty.node', 'spawn-helper'],
  'darwin-arm64': ['pty.node', 'spawn-helper'],
  'win32-x64': WINDOWS_FILES,
  'win32-arm64': WINDOWS_FILES
};

/** Must be executable, or the fork succeeds and the spawn does not. */
const MUST_BE_EXECUTABLE = ['darwin-x64/spawn-helper', 'darwin-arm64/spawn-helper'];

/** Without these the extension has no entry point, or a webview with no styles. */
const REQUIRED_IN_VSIX = [
  'dist/extension.js',
  'media/main.js',
  'media/styles.css',
  'media/xterm.css',
  'resources/panel-statusline.js'
];

function fail(headline, details) {
  console.error(`\x1b[31m✗ ${headline}\x1b[0m`);
  for (const detail of details) {
    console.error(`    ${detail}`);
  }
  process.exit(1);
}

function exists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

// --- source side -----------------------------------------------------------------------------

/**
 * Restores the executable bit wherever a spawn-helper sits: the four prebuild directories, and
 * `build/Release` when node-gyp has compiled one (that is the Linux case — node-pty 1.1.0 ships
 * no Linux prebuild, so `npm install` falls back to a source build there).
 */
function fixSpawnHelperModes() {
  const candidates = [path.join(BUILD_RELEASE, 'spawn-helper')];
  try {
    for (const entry of fs.readdirSync(PREBUILDS)) {
      candidates.push(path.join(PREBUILDS, entry, 'spawn-helper'));
    }
  } catch {
    // Missing prebuilds directory is reported by the completeness check below
  }

  const fixed = [];
  for (const candidate of candidates) {
    if (!exists(candidate)) continue;
    if ((fs.statSync(candidate).mode & 0o111) !== 0) continue;
    fs.chmodSync(candidate, 0o755);
    fixed.push(path.relative(ROOT, candidate));
  }
  return fixed;
}

function checkSource() {
  const fixed = fixSpawnHelperModes();

  const missing = [];
  for (const [platform, files] of Object.entries(REQUIRED_PREBUILDS)) {
    for (const file of files) {
      const full = path.join(PREBUILDS, platform, file);
      if (!exists(full)) {
        missing.push(path.relative(ROOT, full));
      }
    }
  }

  if (missing.length > 0) {
    fail('prebuilds are incomplete — run `npm ci` and check node-pty has not changed its layout', [
      ...missing,
      '',
      'Every platform listed here has to ship: the .vsix is installed on Intel and ARM alike.'
    ]);
  }

  for (const relative of fixed) {
    console.log(`  chmod +x ${relative}`);
  }
  console.log(
    `\x1b[32m✓ prebuilds complete for ${Object.keys(REQUIRED_PREBUILDS).join(', ')}\x1b[0m`
  );
}

// --- archive side ----------------------------------------------------------------------------

/**
 * Reads names and Unix modes out of a zip's central directory. Written by hand rather than with
 * a dependency: this must keep working when node_modules is in whatever state packaging left it,
 * and the format is four field offsets.
 */
function readZipEntries(buffer) {
  const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
  const CENTRAL_FILE_HEADER = 0x02014b50;

  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === END_OF_CENTRAL_DIRECTORY) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('no end-of-central-directory record — not a zip archive');
  }

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) {
      throw new Error(`central directory entry ${String(i)} is malformed`);
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    // The upper half of the external attributes is the Unix st_mode the file was stored with.
    const mode = (buffer.readUInt32LE(offset + 38) >>> 16) & 0o7777;
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.push({ name, mode });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function defaultVsixPath() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return path.join(ROOT, `${manifest.name}-${manifest.version}.vsix`);
}

function checkVsix(vsixPath) {
  const target = vsixPath ? path.resolve(ROOT, vsixPath) : defaultVsixPath();
  if (!exists(target)) {
    fail('no .vsix to check', [path.relative(ROOT, target)]);
  }

  let entries;
  try {
    entries = readZipEntries(fs.readFileSync(target));
  } catch (error) {
    fail(`${path.basename(target)} could not be read as a zip archive`, [String(error)]);
  }
  const modes = new Map(entries.map((entry) => [entry.name, entry.mode]));

  const problems = [];

  for (const required of REQUIRED_IN_VSIX) {
    if (!modes.has(`extension/${required}`)) {
      problems.push(`missing: ${required}`);
    }
  }

  for (const [platform, files] of Object.entries(REQUIRED_PREBUILDS)) {
    for (const file of files) {
      const name = `extension/node_modules/node-pty/prebuilds/${platform}/${file}`;
      if (!modes.has(name)) {
        problems.push(`missing: ${platform}/${file}`);
      }
    }
  }

  for (const relative of MUST_BE_EXECUTABLE) {
    const name = `extension/node_modules/node-pty/prebuilds/${relative}`;
    const mode = modes.get(name);
    if (mode !== undefined && (mode & 0o111) === 0) {
      problems.push(`not executable (${mode.toString(8)}): ${relative} — every spawn would fail`);
    }
  }

  // node-pty's loader looks in build/Release before the prebuilds. .vscodeignore lets a compiled
  // pair through on purpose (the Linux case), so a spawn-helper there wins the race and has to
  // carry the bit too — and must not arrive without its pty.node.
  const compiled = 'extension/node_modules/node-pty/build/Release';
  const compiledHelper = modes.get(`${compiled}/spawn-helper`);
  if (compiledHelper !== undefined) {
    if ((compiledHelper & 0o111) === 0) {
      problems.push(
        `not executable (${compiledHelper.toString(8)}): build/Release/spawn-helper — loaded before the prebuilds`
      );
    }
    if (!modes.has(`${compiled}/pty.node`)) {
      problems.push('build/Release/spawn-helper packaged without build/Release/pty.node');
    }
  }

  // A `**` glob over the Windows prebuilds would drag in 55 MB of debug symbols unnoticed.
  const debugSymbols = entries.filter((entry) => entry.name.endsWith('.pdb'));
  if (debugSymbols.length > 0) {
    problems.push(`${String(debugSymbols.length)} .pdb debug symbols were packaged`);
  }

  // `*.ts` and `tsconfig.json` in .vscodeignore do not cross a directory boundary, so the webview
  // sources under media/ shipped unnoticed. The bundle is what loads; sources never belong here.
  const sources = entries.filter(
    (entry) => entry.name.endsWith('.ts') || entry.name.endsWith('/tsconfig.json')
  );
  if (sources.length > 0) {
    problems.push(
      `${String(sources.length)} TypeScript sources were packaged: ${sources
        .map((entry) => entry.name.replace(/^extension\//, ''))
        .join(', ')}`
    );
  }

  if (problems.length > 0) {
    fail(`${path.basename(target)} is not installable everywhere`, problems);
  }

  const bytes = fs.statSync(target).size;
  console.log(
    `\x1b[32m✓ ${path.basename(target)}: ${String(entries.length)} files, ` +
      `${(bytes / 1024 / 1024).toFixed(2)} MB, all prebuilds present and executable\x1b[0m`
  );
}

// --- entry point -----------------------------------------------------------------------------

const [mode, argument] = process.argv.slice(2);

if (mode === '--source') {
  checkSource();
} else if (mode === '--vsix') {
  checkVsix(argument);
} else {
  console.error('usage: node scripts/verify-package-payload.js --source | --vsix [path]');
  process.exit(1);
}
