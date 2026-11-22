// eslint.config.ts, as ESLint itself loads it (through jiti).
//
// Implicit `any` (a JSON.parse result, an untyped library field, a stream's
// 'data' chunk) is kept out of the TypeScript by typescript-eslint's no-unsafe-*
// rules. They are only a guarantee while they stay errors and every linted .ts
// file stays inside one of the typed programs they need: downgraded to a
// warning, the lint step still passes. So this pins both, and lints a known
// violation in each typed program to prove the rules actually report.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ESLint } = require('eslint');

const REPO = path.join(__dirname, '..');

const UNSAFE_RULES = [
  '@typescript-eslint/no-unsafe-argument',
  '@typescript-eslint/no-unsafe-assignment',
  '@typescript-eslint/no-unsafe-call',
  '@typescript-eslint/no-unsafe-declaration-merging',
  '@typescript-eslint/no-unsafe-enum-comparison',
  '@typescript-eslint/no-unsafe-function-type',
  '@typescript-eslint/no-unsafe-member-access',
  '@typescript-eslint/no-unsafe-return',
  '@typescript-eslint/no-unsafe-unary-minus',
];

const PROJECTS = ['./tsconfig.json', './tsconfig.renderer.json', './tsconfig.tooling.json'];

// At least one file from each typed program: the main process and preloads
// (tsconfig.json), the renderer (tsconfig.renderer.json) and the root configs
// (tsconfig.tooling.json), plus declaration files from the first two.
const TYPED_FILES = [
  'src/main.ts',
  'src/preload.ts',
  'src/Modules/Utils/index.ts',
  'src/types/client.d.ts',
  'src/UI/js/app/main.ts',
  'src/UI/types/global.d.ts',
  'forge.config.ts',
  'eslint.config.ts',
];

let Linter = null;
function linter() {
  Linter ??= new ESLint({ cwd: REPO });
  return Linter;
}

test('every TypeScript file is linted with type information and the no-unsafe rules as errors', async () => {
  for (const File of TYPED_FILES) {
    const Config = await linter().calculateConfigForFile(path.join(REPO, File));
    assert.deepEqual(Config.languageOptions.parserOptions.project, PROJECTS, File);
    assert.equal(Config.languageOptions.parserOptions.tsconfigRootDir, REPO, File);
    assert.deepEqual(Config.rules['@typescript-eslint/no-explicit-any'], [2], File);
    for (const Rule of UNSAFE_RULES) {
      assert.deepEqual(Config.rules[Rule], [2], `${File}: ${Rule}`);
    }
  }
});

test('JavaScript (tests and scripts) is linted as before, without type information', async () => {
  for (const File of ['test/test-helpers.js', 'scripts/copy-assets.js']) {
    const Config = await linter().calculateConfigForFile(path.join(REPO, File));
    assert.equal(Config.languageOptions.parserOptions?.project, undefined, File);
    assert.equal(Config.rules['@typescript-eslint/no-unsafe-assignment'], undefined, File);
    assert.ok(Config.rules['no-unused-vars'], File);
  }
});

test('the protocol submodule is not linted here', async () => {
  assert.equal(await linter().isPathIgnored(path.join(REPO, 'shared', 'src', 'index.d.ts')), true);
  assert.equal(
    await linter().isPathIgnored(path.join(REPO, 'shared', 'src', 'runtime', 'index.ts')),
    true
  );
});

test('an `any` from JSON.parse is reported in each typed program', async () => {
  const Code = [
    "export const Parsed = JSON.parse('{}');",
    'export const Field: string = Parsed.Field;',
    '',
  ].join('\n');
  for (const File of [
    'src/Modules/Utils/index.ts',
    'src/UI/js/app/lib/dom.ts',
    'forge.config.ts',
  ]) {
    const [Result] = await linter().lintText(Code, { filePath: path.join(REPO, File) });
    const Reported = Result.messages.map((Message) => `${Message.ruleId}@${Message.line}`);
    assert.deepEqual(
      Reported.sort(),
      [
        '@typescript-eslint/no-unsafe-assignment@1',
        '@typescript-eslint/no-unsafe-assignment@2',
        '@typescript-eslint/no-unsafe-member-access@2',
      ],
      File
    );
    assert.ok(
      Result.messages.every((Message) => Message.severity === 2),
      `${File}: reported as errors`
    );
  }
});
