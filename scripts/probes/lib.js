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

module.exports = { check, finish };
