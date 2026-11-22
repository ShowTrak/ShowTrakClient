import type { ForgeConfig } from '@electron-forge/shared-types';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import path from 'node:path';
import fs from 'node:fs';

// Forge loads this file through jiti, which transpiles it on the fly and runs it
// with CommonJS's `__dirname` and `require` available. tsconfig.tooling.json
// typechecks it as part of `npm run typecheck`.

type PackagerConfig = NonNullable<ForgeConfig['packagerConfig']>;

/**
 * Keys this config has always set that the tools Forge 8 drives no longer read,
 * which is why Forge's types reject them. @electron/osx-sign 2 takes entitlements
 * and hardened runtime per file, from `optionsForFile` (falling back to its own
 * built-in entitlements, with hardened runtime on), and has no Gatekeeper
 * assessment step; @electron/notarize 3 always uses notarytool. So a signed build
 * does not carry build/entitlements.mac.plist today.
 *
 * They are declared here rather than dropped so that moving this file to
 * TypeScript hands Forge exactly the config it had before. Making the
 * entitlements take effect (through optionsForFile) would change what a signed
 * build contains, so it needs checking on a signed, notarized build first.
 */
interface LegacyOsxSignKeys {
  hardenedRuntime: boolean;
  entitlements: string;
  entitlementsInherit: string;
  gatekeeperAssess: boolean;
}
type OsxSignOptions = Exclude<NonNullable<PackagerConfig['osxSign']>, true> & LegacyOsxSignKeys;
type OsxNotarizeOptions = NonNullable<PackagerConfig['osxNotarize']> & { tool: 'notarytool' };

const appleSignIdentity = process.env.APPLE_SIGN_IDENTITY;
const appleSigningKeychain = process.env.APPLE_KEYCHAIN_PATH;
const appleApiKeyPath = process.env.APPLE_API_KEY_PATH;
const appleApiKeyId = process.env.APPLE_API_KEY_ID;
const appleApiIssuerId = process.env.APPLE_API_ISSUER_ID;
const shouldSignMac = Boolean(appleSignIdentity);

const osxSign: OsxSignOptions | undefined = shouldSignMac
  ? {
      identity: appleSignIdentity,
      ...(appleSigningKeychain ? { keychain: appleSigningKeychain } : {}),
      hardenedRuntime: true,
      entitlements: path.resolve(__dirname, 'build/entitlements.mac.plist'),
      entitlementsInherit: path.resolve(__dirname, 'build/entitlements.mac.plist'),
      gatekeeperAssess: false,
      strictVerify: true,
    }
  : undefined;

// Notarizing needs a signed app and all three App Store Connect API key values.
const osxNotarize: OsxNotarizeOptions | undefined =
  shouldSignMac && appleApiKeyPath && appleApiKeyId && appleApiIssuerId
    ? {
        tool: 'notarytool',
        appleApiKey: appleApiKeyPath,
        appleApiKeyId,
        appleApiIssuer: appleApiIssuerId,
      }
    : undefined;

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    // Copy the *contents* of symlinks rather than the links themselves.
    //
    // node_modules/@showtrak/protocol is npm's link for the `file:./shared`
    // dependency. Left as a link, Electron Packager hands it to @electron/asar,
    // which stores a `link` entry -- and on Windows npm creates a *junction*
    // whose readlink is an absolute path, so the recorded target came out as the
    // nonsense `node_modules\@showtrak\D:\a\ShowTrakClient\ShowTrakClient\shared`
    // (3.16.1 shipped exactly that). Every
    // `require('@showtrak/protocol/runtime')` then threw MODULE_NOT_FOUND on
    // boot, while macOS and Linux worked because their relative symlinks
    // happened to resolve inside the archive.
    //
    // Dereferencing sidesteps the platform difference entirely: the package
    // lands in the asar as a real directory on all three targets.
    derefSymlinks: true,
    // Keep the asar lean: only `dist/`, production `node_modules`, and
    // package.json are needed at runtime. Without an ignore list, Electron
    // Packager bundles the entire project tree (src/, test/, source maps,
    // dotfiles). Top-level dirs are anchored with `^/` so we don't accidentally
    // match paths inside node_modules.
    ignore: [
      // Source & build inputs — the renderer, images and icons are served from
      // dist/ (copied there by scripts/copy-assets.js); the app icon is read
      // from disk at package time, not from the asar.
      /^\/src($|\/)/,
      // shared/ is the @showtrak/protocol submodule. With derefSymlinks the
      // package ships as real files under node_modules/@showtrak/protocol, so
      // this second copy at the top level is dead weight — drop it wholesale.
      /^\/shared($|\/)/,
      // ...and inside the dereferenced copy, ship exactly what Node needs to
      // resolve `@showtrak/protocol/runtime`: package.json for the exports map
      // and the compiled dist/. The .d.ts sources, tsconfigs, LICENSE and
      // README are build-time only.
      /^\/node_modules\/@showtrak\/protocol\/(?!dist(\/|$)|package\.json$)/,
      /^\/scripts($|\/)/,
      /^\/build($|\/)/,
      // Tests. dist-test/ is the test-only per-file compile of the renderer
      // (tsconfig.renderer.test.json); the app runs the esbuild bundles in
      // dist/, so this must never ship.
      /^\/test($|\/)/,
      /^\/dist-test($|\/)/,
      /^\/coverage($|\/)/,
      // Repo/tooling directories.
      /^\/\.github($|\/)/,
      /^\/\.husky($|\/)/,
      /^\/\.vscode($|\/)/,
      // Config & docs. Forge and ESLint read their configs from the project,
      // never from the packaged app.
      /^\/tsconfig.*\.json$/,
      /^\/(eslint|forge)\.config\.ts$/,
      /^\/\.prettier/,
      /^\/\.gitignore$/,
      /^\/\.gitattributes$/,
      /^\/\.gitmodules$/,
      /^\/(README|DEVELOPMENT)\.md$/,
      /^\/package-lock\.json$/,
      // Source maps are debug-only; strip from release builds.
      /\.map$/,
      // Cruft.
      /\.DS_Store$/,
    ],
    // Keep the runtime binary name stable across platforms so Linux makers
    // can reliably locate it when building deb/rpm packages.
    executableName: 'showtrak-client',
    // Use extensionless base path so Electron Packager can resolve
    // platform-specific icon formats (.icns on macOS, .ico on Windows).
    icon: './src/images/icon',
    // Run as a macOS menu-bar agent (no Dock icon) so the client lives in the
    // tray, matching the Windows background-service behavior.
    extendInfo: {
      LSUIElement: 1,
      // macOS Local Network privacy: Bonjour discovery is raw multicast on UDP
      // 5353, which macOS blocks for an app that has not been granted Local
      // Network access. This string is what the permission prompt shows.
      NSLocalNetworkUsageDescription:
        'ShowTrak Client needs local network access to find and connect to your ShowTrak Server.',
    },
    ...(osxSign ? { osxSign } : {}),
    ...(osxNotarize ? { osxNotarize } : {}),
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        // An URL to an ICO file to use as the application icon (displayed in Control Panel > Programs and Features).
        iconUrl: 'https://tkw.bz/img/ShowTrak.ico',
        // The ICO file to use as the icon for the generated Setup.exe
        setupIcon: './src/images/icon.ico',
      },
    },
    // Forge's types require `config` on every maker listed by name; `{}` is the
    // default a maker falls back to when it is left out.
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
      config: {},
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['linux'],
      config: {},
    },
    {
      name: '@electron-forge/maker-deb',
      platforms: ['linux'],
      config: {
        options: {
          bin: 'showtrak-client',
        },
      },
    },
    {
      name: '@electron-forge/maker-rpm',
      platforms: ['linux'],
      config: {
        options: {
          bin: 'showtrak-client',
        },
      },
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
  hooks: {
    // Drop Chromium's UI translations (~45 MB) before the app is copied in and
    // signed; the UI is English and Chromium falls back to en-US. See
    // scripts/trim-electron-locales.js, which runs the one shared with
    // ShowTrak Server and Timers (shared/scripts/).
    packageAfterExtract: async (_forgeConfig, buildPath) => {
      // scripts/ stays JavaScript, outside any TypeScript program, so the one
      // export used here is declared rather than inferred.
      const { trimElectronLocales } = require('./scripts/trim-electron-locales') as {
        trimElectronLocales: (buildPath: string) => number;
      };
      const removed = trimElectronLocales(buildPath);
      console.log(`[forge] Removed ${removed} unused Chromium locale pack(s)`);
    },
    // 3.16.1 shipped a Windows build whose @showtrak/protocol was an unusable
    // link (see derefSymlinks above) and nothing caught it until the app failed
    // to boot on a user's machine. The dependency resolves by bare specifier, so
    // a broken copy is invisible until runtime — assert the real files are in
    // the staged tree, on every platform, before it gets sealed into the asar.
    packageAfterCopy: async (_forgeConfig, buildPath) => {
      const pkgDir = path.join(buildPath, 'node_modules', '@showtrak', 'protocol');
      // lstat, not stat: a surviving symlink is the failure we are guarding
      // against, and it would follow through to the real file on the build host.
      const linkStat = fs.lstatSync(pkgDir, { throwIfNoEntry: false });
      if (!linkStat?.isDirectory()) {
        throw new Error(
          `Packaging aborted: ${pkgDir} is ${linkStat ? 'a link, not a real directory' : 'missing'}. ` +
            'The @showtrak/protocol dependency must be dereferenced into the package.'
        );
      }
      for (const rel of [['package.json'], ['dist', 'runtime', 'index.js']]) {
        const file = path.join(pkgDir, ...rel);
        if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) {
          throw new Error(
            `Packaging aborted: ${file} is missing from the staged app. ` +
              'require("@showtrak/protocol/runtime") would throw at boot.'
          );
        }
      }
    },
  },
};

export default config;
