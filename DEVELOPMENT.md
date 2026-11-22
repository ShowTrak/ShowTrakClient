# Developing ShowTrak Client

The technical reference for building and working on ShowTrak Client. For what it does and how to get it, see the [README](README.md) or [showtrak.co.uk](https://showtrak.co.uk).

## Requirements

- Node.js 24+ (CI uses Node 24)
- npm
- macOS, Windows, or Linux

## Local Development

```bash
git clone --recurse-submodules https://github.com/ShowTrak/ShowTrakClient.git
npm ci
npm run start
```

`shared/` is a git submodule ([ShowTrak-Protocol](https://github.com/ShowTrak/ShowTrak-Protocol)).
In an existing checkout, `git submodule update --init --recursive` fetches it.

### Useful Scripts

```bash
# Build, then run the app
npm run start

# Build distributables for the current platform
npm run make

# Run the test suite (builds first). On macOS and Linux, a throwaway HOME keeps
# anything a test writes out of your real profile.
HOME=$(mktemp -d) npm test

# Run one test file
npm test -- test/script-catalog-generations.test.js

# Run tests with coverage report
npm run test:coverage

# Lint, format, typecheck
npm run lint
npm run format
npm run format:check
npm run typecheck

# Cut a release (dispatches the Build workflow; see scripts/publish-release.js)
npm run publish
```

## TypeScript

Everything under `src/` is TypeScript; the tests and build scripts are JavaScript.
`npm run typecheck` checks each surface against its own environment:

- `tsconfig.json` - the main process and the three preloads (compiled to `dist/` by `tsc`)
- `tsconfig.renderer.json` - the config window and the two overlay pages, with the DOM
  (bundled by esbuild, `scripts/build-renderer.js`)
- `tsconfig.tooling.json` - `forge.config.ts` and `eslint.config.ts`, which Forge and
  ESLint load through jiti

`tsconfig.renderer.test.json` compiles the renderer a second time, as CommonJS in
`dist-test/`, so the tests can load it. It runs before the tests, not in `typecheck`.

`eslint.config.ts` lints the TypeScript with type information, and allows no `any`:
neither written (`no-explicit-any`) nor arriving untyped from `JSON.parse`, an IPC
payload or a library (the `no-unsafe-*` rules). Narrow such a value from `unknown`;
`IsRecord` and `IsArray` (`@showtrak/protocol/common`) and `Unverified<T>` (in
`src/Modules/Utils`) help.

### Where the Types Live

Every type that crosses a process or network boundary comes from the shared protocol
in `shared/`. Its two type entry points are imported with `import type`:

- `@showtrak/protocol` - the Socket.IO wire to ShowTrak Server, shared with it,
  including the script catalog as every supported Server sends it
  (`ScriptCatalogWireEntry`).
- `@showtrak/protocol/client` - this app's own boundaries: the preload bridges and IPC
  channels (`ClientPreloadAPI`, `InvokeMap`, `PushMap`), the overlay windows' query
  strings, and the files it keeps in its profile directory (`ClientProfile`,
  `ManualServer` and the state files beside them).

The rest is real code shared with ShowTrak Server and Timers, built by
`npm run build:shared`: `@showtrak/protocol/runtime` (logging, checksums, the update
channel, the process guards), `@showtrak/protocol/common` (type guards, script
argument parsing) and `@showtrak/protocol/electron-main` (the window guards).

`src/types/` holds only what stays inside the main process: the Broadcast bus, the
managers' results, the typed Socket.IO socket and declarations for untyped packages.
A change to a shared type is made in ShowTrak-Protocol and picked up by moving the
submodule. The wire must stay readable by older and newer Servers alike.

## Repository Layout

- `src/main.ts`, `src/main/` - Electron main process: lifecycle, IPC handlers, tray,
  updater, recovery
- `src/Modules/` - the managers: server connection, adoption, monitors, scripts, profile
- `src/preload.ts`, `src/identify-preload.ts`, `src/launch-countdown-preload.ts` -
  preload bridges and their channel allowlists
- `src/UI/` - the config window and the overlay pages
- `shared/` - `@showtrak/protocol` (git submodule)
- `test/` - Node test runner suite
- `scripts/` - build, packaging and release helpers
- `forge.config.ts` - Electron Forge packaging/maker/signing configuration
