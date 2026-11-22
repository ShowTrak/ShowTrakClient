// `npm test`: node --test over this app's own suite, test/**/*.test.js.
//
// Bare `node --test` runs every file matching its default pattern anywhere
// outside node_modules, which takes in the shared/ submodule too: a spec or
// script there named like a test file would run as one of this app's tests. So
// the suite is named explicitly, unless files are given: `npm test --
// test/x.test.js` runs just those. Options are passed through either way; give
// a value with `=` (--test-name-pattern=foo), or it reads as a file.
const { spawnSync } = require('node:child_process');

const Args = process.argv.slice(2);
const NamesFiles = Args.some((Arg) => !Arg.startsWith('-'));
const Result = spawnSync(
  process.execPath,
  ['--test', ...Args, ...(NamesFiles ? [] : ['test/**/*.test.js'])],
  { stdio: 'inherit' }
);
process.exitCode = Result.status ?? 1;
