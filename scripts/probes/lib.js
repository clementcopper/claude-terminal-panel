/** Shared bits for the probes: a check that prints one line and remembers failures. */
const failures = [];

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `${ok ? '✓' : '✗'} ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`
  );
  if (!ok) failures.push(name);
}

function finish(title) {
  if (failures.length > 0) {
    console.error(`\x1b[31m✗ ${title}: ${String(failures.length)} check(s) failed\x1b[0m`);
    process.exit(1);
  }
  console.log(`\x1b[32m✓ ${title}\x1b[0m`);
}

/**
 * chrome-headless-shell from the Playwright cache, whatever its build number and architecture:
 * the probes were written against `chromium_headless_shell-1228/…-mac-arm64`, and an Intel Mac
 * holds `-1223/…-mac-x64`, so a fixed path skipped both CDP probes there with exit 0.
 * `PROBE_CHROME` overrides. Newest build first.
 */
function findHeadlessChrome() {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  if (process.env.PROBE_CHROME) return process.env.PROBE_CHROME;
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  let builds = [];
  try {
    builds = fs.readdirSync(cache).filter((name) => name.startsWith('chromium_headless_shell-'));
  } catch {
    return undefined;
  }
  builds.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  for (const build of builds) {
    const binary = path.join(
      cache,
      build,
      `chrome-headless-shell-mac-${arch}`,
      'chrome-headless-shell'
    );
    if (fs.existsSync(binary)) return binary;
  }
  return undefined;
}

module.exports = { check, finish, findHeadlessChrome };
