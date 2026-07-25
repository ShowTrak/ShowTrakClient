// Bundles the TypeScript renderer sources with esbuild.
//
// The Node-side code is compiled by `tsc` (tsconfig.json) into dist/. The
// renderer runs in an Electron renderer context and is authored as ES modules
// that are bundled here into a single classic script per window:
//   src/UI/js/app/main.ts               -> dist/UI/js/app/main.js
//   src/UI/js/app/identify-overlay.ts   -> dist/UI/js/app/identify-overlay.js
//   src/UI/js/app/launch-countdown.ts   -> dist/UI/js/app/launch-countdown.js
//
// Type-checking is performed separately by `tsc --noEmit` against
// tsconfig.renderer.json; esbuild only transpiles+bundles.
//
// Vendor libraries (jQuery, Bootstrap) stay as external <script> globals for
// offline use, so they are NOT imported/bundled.
const esbuild = require('esbuild');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** @type {Array<{name: string, entry: string, outfile: string}>} */
const BUNDLES = [
  {
    name: 'Config window',
    entry: path.join(ROOT, 'src', 'UI', 'js', 'app', 'main.ts'),
    outfile: path.join(ROOT, 'dist', 'UI', 'js', 'app', 'main.js'),
  },
  {
    name: 'Identify overlay',
    entry: path.join(ROOT, 'src', 'UI', 'js', 'app', 'identify-overlay.ts'),
    outfile: path.join(ROOT, 'dist', 'UI', 'js', 'app', 'identify-overlay.js'),
  },
  {
    name: 'Launch countdown overlay',
    entry: path.join(ROOT, 'src', 'UI', 'js', 'app', 'launch-countdown.ts'),
    outfile: path.join(ROOT, 'dist', 'UI', 'js', 'app', 'launch-countdown.js'),
  },
];

async function buildBundle({ name, entry, outfile }) {
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'iife',
    target: 'es2022',
    platform: 'browser',
    sourcemap: true,
    legalComments: 'none',
    logLevel: 'info',
  });
  console.log(`[build-renderer] Bundled ${name} -> ${path.relative(ROOT, outfile)}`);
}

async function main() {
  for (const bundle of BUNDLES) {
    await buildBundle(bundle);
  }
  console.log(`[build-renderer] Completed (${BUNDLES.length} bundles)`);
}

main().catch((err) => {
  console.error('[build-renderer] Failed:', err);
  process.exit(1);
});
