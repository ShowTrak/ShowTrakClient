// forge.config.ts, read the way Electron Forge reads it.
//
// The config is TypeScript that Forge transpiles on the fly (through jiti), and
// nothing else in the build loads it: a broken import or a hook that throws only
// surfaces when someone runs `npm run make`, usually on a release runner. So
// these tests go through Forge's OWN loader, which also resolves the plugins and
// runs their resolveForgeConfig hooks, exactly as a packaging run would; then
// they run the two packaging hooks against staged trees in a temp dir.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const REPO = path.join(__dirname, '..');
const FORGE_LOADER = path.join(
  REPO,
  'node_modules',
  '@electron-forge',
  'core',
  'dist',
  'util',
  'forge-config.js'
);

// The config reads these when it is evaluated. Clear them so the in-process load
// below is the plain, unsigned build whatever the developer's shell exports.
const SIGNING_ENV = [
  'APPLE_SIGN_IDENTITY',
  'APPLE_KEYCHAIN_PATH',
  'APPLE_API_KEY_PATH',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER_ID',
];
for (const Name of SIGNING_ENV) delete process.env[Name];

/** Forge's loader, as `electron-forge package` and `make` call it. */
async function loadForgeConfig() {
  const { default: load } = await import(pathToFileURL(FORGE_LOADER).href);
  return load(REPO);
}

let ConfigPromise = null;
function forgeConfig() {
  ConfigPromise ??= loadForgeConfig();
  return ConfigPromise;
}

/**
 * The signing part of the config under a given environment.
 *
 * Run in a child process: the config reads the environment when it is
 * evaluated, and jiti caches the evaluated module for the life of the process.
 */
const SIGNING_PROBE = `
const { pathToFileURL } = require('node:url');
import(pathToFileURL(process.env.FORGE_LOADER).href)
  .then(({ default: load }) => load(process.env.FORGE_REPO))
  .then((config) => {
    const { osxSign, osxNotarize } = config.packagerConfig;
    process.stdout.write(JSON.stringify({ osxSign: osxSign ?? null, osxNotarize: osxNotarize ?? null }));
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
`;

function signingConfig(Env) {
  const Clean = { ...process.env };
  for (const Name of SIGNING_ENV) delete Clean[Name];
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['-e', SIGNING_PROBE],
      {
        cwd: REPO,
        env: { ...Clean, FORGE_LOADER, FORGE_REPO: REPO, ...Env },
        timeout: 60000,
      },
      (Err, Stdout, Stderr) => {
        if (Err) return reject(new Error(`${Err.message}\n${Stderr}`));
        resolve(JSON.parse(Stdout));
      }
    );
  });
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function touch(file, contents = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

/** Run `fn` with console.log captured, returning what it logged. */
async function captureLog(fn) {
  const Lines = [];
  const Original = console.log;
  console.log = (...Args) => Lines.push(Args.join(' '));
  try {
    await fn();
  } finally {
    console.log = Original;
  }
  return Lines;
}

// ===========================================================================
// The resolved config
// ===========================================================================

test('Forge loads forge.config.ts and resolves its makers', async () => {
  const Config = await forgeConfig();
  assert.deepEqual(JSON.parse(JSON.stringify(Config.makers)), [
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        iconUrl: 'https://tkw.bz/img/ShowTrak.ico',
        setupIcon: './src/images/icon.ico',
      },
    },
    { name: '@electron-forge/maker-zip', platforms: ['darwin'], config: {} },
    { name: '@electron-forge/maker-zip', platforms: ['linux'], config: {} },
    {
      name: '@electron-forge/maker-deb',
      platforms: ['linux'],
      config: { options: { bin: 'showtrak-client' } },
    },
    {
      name: '@electron-forge/maker-rpm',
      platforms: ['linux'],
      config: { options: { bin: 'showtrak-client' } },
    },
  ]);
  assert.deepEqual(Config.publishers, []);
  assert.deepEqual(JSON.parse(JSON.stringify(Config.rebuildConfig)), {});
});

test('the plugins load, and the fuses are the ones this app ships with', async () => {
  const Config = await forgeConfig();
  const { FuseV1Options, FuseVersion } = await import('@electron/fuses');

  const [Natives, Fuses, ...Rest] = Config.plugins;
  assert.deepEqual(Rest, []);
  assert.deepEqual(JSON.parse(JSON.stringify(Natives)), {
    name: '@electron-forge/plugin-auto-unpack-natives',
    config: {},
  });

  assert.equal(Fuses.constructor.name, 'FusesPlugin');
  assert.equal(Fuses.config.version, FuseVersion.V1);
  assert.equal(Fuses.config[FuseV1Options.RunAsNode], false);
  assert.equal(Fuses.config[FuseV1Options.EnableCookieEncryption], true);
  assert.equal(Fuses.config[FuseV1Options.EnableNodeOptionsEnvironmentVariable], false);
  assert.equal(Fuses.config[FuseV1Options.EnableNodeCliInspectArguments], false);
  assert.equal(Fuses.config[FuseV1Options.EnableEmbeddedAsarIntegrityValidation], true);
  assert.equal(Fuses.config[FuseV1Options.OnlyLoadAppFromAsar], true);
});

test('the packager options survive the load, including the plugin rewrite of asar', async () => {
  const Config = await forgeConfig();
  const Packager = Config.packagerConfig;

  // `asar: true` in the file; auto-unpack-natives' resolveForgeConfig hook turns
  // it into an unpack glob for native modules. Seeing it proves the plugin ran.
  assert.match(Packager.asar.unpack, /\*\.node$/);
  assert.equal(Packager.derefSymlinks, true);
  assert.equal(Packager.executableName, 'showtrak-client');
  assert.equal(Packager.icon, './src/images/icon');
  assert.equal(Packager.extendInfo.LSUIElement, 1);
  assert.match(Packager.extendInfo.NSLocalNetworkUsageDescription, /local network access/);
  assert.equal(Packager.osxSign, undefined, 'an unsigned build signs nothing');
  assert.equal(Packager.osxNotarize, undefined);

  assert.deepEqual(Object.keys(Config.hooks).sort(), ['packageAfterCopy', 'packageAfterExtract']);
  assert.equal(typeof Config.hooks.packageAfterCopy, 'function');
  assert.equal(typeof Config.hooks.packageAfterExtract, 'function');
});

test('the ignore list keeps the runtime and drops sources, tooling and tests', async () => {
  const { ignore } = (await forgeConfig()).packagerConfig;
  const Ignored = (File) => ignore.some((Pattern) => Pattern.test(File));

  for (const File of [
    '/package.json',
    '/dist/main.js',
    '/dist/UI/index.html',
    '/node_modules/socket.io-client/package.json',
    '/node_modules/@showtrak/protocol/package.json',
    '/node_modules/@showtrak/protocol/dist/runtime/index.js',
  ]) {
    assert.equal(Ignored(File), false, `${File} is needed at run time`);
  }
  for (const File of [
    '/src/main.ts',
    '/shared/src/index.d.ts',
    '/node_modules/@showtrak/protocol/src/index.d.ts',
    '/node_modules/@showtrak/protocol/tsconfig.json',
    '/scripts/build-renderer.js',
    '/build/entitlements.mac.plist',
    '/test/forge-config.test.js',
    '/dist-test/UI/js/app/main.js',
    '/coverage/lcov.info',
    '/eslint.config.ts',
    '/forge.config.ts',
    '/tsconfig.json',
    '/tsconfig.tooling.json',
    '/tsconfig.renderer.json',
    '/tsconfig.renderer.test.json',
    '/README.md',
    '/DEVELOPMENT.md',
    '/package-lock.json',
    '/dist/main.js.map',
  ]) {
    assert.equal(Ignored(File), true, `${File} must not ship`);
  }
});

test('signing and notarizing follow the environment', async () => {
  const Identity = 'Developer ID Application: Test (TEAM123456)';
  const Entitlements = path.join(REPO, 'build', 'entitlements.mac.plist');
  const ApiKey = {
    APPLE_API_KEY_PATH: '/tmp/AuthKey.p8',
    APPLE_API_KEY_ID: 'KEY123',
    APPLE_API_ISSUER_ID: 'issuer-uuid',
  };
  const ExpectedSign = {
    identity: Identity,
    hardenedRuntime: true,
    entitlements: Entitlements,
    entitlementsInherit: Entitlements,
    gatekeeperAssess: false,
    strictVerify: true,
  };

  const [Unsigned, Signed, Full, Partial, NotarizeOnly] = await Promise.all([
    signingConfig({}),
    signingConfig({ APPLE_SIGN_IDENTITY: Identity }),
    signingConfig({
      APPLE_SIGN_IDENTITY: Identity,
      APPLE_KEYCHAIN_PATH: '/tmp/signing.keychain-db',
      ...ApiKey,
    }),
    signingConfig({
      APPLE_SIGN_IDENTITY: Identity,
      APPLE_API_KEY_PATH: ApiKey.APPLE_API_KEY_PATH,
      APPLE_API_KEY_ID: ApiKey.APPLE_API_KEY_ID,
    }),
    signingConfig(ApiKey),
  ]);

  assert.deepEqual(Unsigned, { osxSign: null, osxNotarize: null });
  assert.deepEqual(Signed, { osxSign: ExpectedSign, osxNotarize: null });
  assert.deepEqual(Full, {
    osxSign: {
      identity: Identity,
      keychain: '/tmp/signing.keychain-db',
      hardenedRuntime: true,
      entitlements: Entitlements,
      entitlementsInherit: Entitlements,
      gatekeeperAssess: false,
      strictVerify: true,
    },
    osxNotarize: {
      tool: 'notarytool',
      appleApiKey: '/tmp/AuthKey.p8',
      appleApiKeyId: 'KEY123',
      appleApiIssuer: 'issuer-uuid',
    },
  });
  assert.deepEqual(Partial, Signed, 'notarizing needs all three API key values');
  assert.deepEqual(NotarizeOnly, Unsigned, 'an unsigned app is never notarized');
});

// ===========================================================================
// packageAfterExtract: trims Chromium's locale packs from the extracted Electron
// ===========================================================================

test('packageAfterExtract trims the locale packs, keeping English', async () => {
  const Config = await forgeConfig();
  const Build = tempDir('showtrak-forge-extract-');
  for (const Pak of ['en-US.pak', 'en-GB.pak', 'de.pak', 'fr.pak', 'ja.pak']) {
    touch(path.join(Build, 'locales', Pak));
  }
  const Resources = path.join(
    Build,
    'Electron.app',
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
    'Versions',
    'A',
    'Resources'
  );
  for (const Lproj of ['en.lproj', 'en_GB.lproj', 'de.lproj']) {
    touch(path.join(Resources, Lproj, 'locale.pak'));
  }

  const Logged = await captureLog(() =>
    Config.hooks.packageAfterExtract(Config, Build, '45.0.0', 'darwin', 'arm64')
  );

  assert.deepEqual(fs.readdirSync(path.join(Build, 'locales')).sort(), ['en-GB.pak', 'en-US.pak']);
  assert.deepEqual(fs.readdirSync(Resources).sort(), ['en.lproj', 'en_GB.lproj']);
  assert.deepEqual(Logged, ['[forge] Removed 4 unused Chromium locale pack(s)']);
});

test('packageAfterExtract fails the build rather than ship Electron without en-US', async () => {
  const { hooks } = await forgeConfig();
  const Build = tempDir('showtrak-forge-extract-bad-');
  touch(path.join(Build, 'locales', 'de.pak'));

  await assert.rejects(
    captureLog(() => hooks.packageAfterExtract(null, Build, '45.0.0', 'linux', 'x64')),
    /has no en-US\.pak/
  );
});

// ===========================================================================
// packageAfterCopy: the staged app must carry @showtrak/protocol as real files
// ===========================================================================

function stageProtocol(Build, { packageJson = true, runtime = true } = {}) {
  const Pkg = path.join(Build, 'node_modules', '@showtrak', 'protocol');
  fs.mkdirSync(Pkg, { recursive: true });
  if (packageJson) touch(path.join(Pkg, 'package.json'), '{"name":"@showtrak/protocol"}');
  if (runtime) touch(path.join(Pkg, 'dist', 'runtime', 'index.js'), 'module.exports = {};');
  return Pkg;
}

test('packageAfterCopy accepts a staged app with the protocol package as real files', async () => {
  const { hooks } = await forgeConfig();
  const Build = tempDir('showtrak-forge-copy-ok-');
  stageProtocol(Build);

  await hooks.packageAfterCopy(null, Build, '45.0.0', 'win32', 'x64');
});

test('packageAfterCopy aborts when the protocol package is missing', async () => {
  const { hooks } = await forgeConfig();
  const Build = tempDir('showtrak-forge-copy-missing-');

  await assert.rejects(
    hooks.packageAfterCopy(null, Build, '45.0.0', 'win32', 'x64'),
    /Packaging aborted: .* is missing\. The @showtrak\/protocol dependency must be dereferenced/
  );
});

test('packageAfterCopy aborts when the protocol package is a link, not a directory', async () => {
  // The 3.16.1 failure: a link survived into the staged tree. lstat sees the
  // link itself, even though following it would find a perfectly good package.
  const { hooks } = await forgeConfig();
  const Real = tempDir('showtrak-forge-copy-real-');
  stageProtocol(Real);
  const Build = tempDir('showtrak-forge-copy-link-');
  fs.mkdirSync(path.join(Build, 'node_modules', '@showtrak'), { recursive: true });
  fs.symlinkSync(
    path.join(Real, 'node_modules', '@showtrak', 'protocol'),
    path.join(Build, 'node_modules', '@showtrak', 'protocol'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );

  await assert.rejects(
    hooks.packageAfterCopy(null, Build, '45.0.0', 'win32', 'x64'),
    /is a link, not a real directory/
  );
});

test('packageAfterCopy aborts when the package lacks what Node needs to resolve it', async () => {
  const { hooks } = await forgeConfig();
  for (const [Label, Options, Missing] of [
    ['no package.json', { packageJson: false }, /package\.json is missing from the staged app/],
    ['no compiled runtime', { runtime: false }, /index\.js is missing from the staged app/],
  ]) {
    const Build = tempDir('showtrak-forge-copy-partial-');
    stageProtocol(Build, Options);
    await assert.rejects(
      hooks.packageAfterCopy(null, Build, '45.0.0', 'linux', 'x64'),
      Missing,
      Label
    );
  }
});
