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
// The renderer has no vendor scripts: the config window paints itself through
// src/UI/js/app/lib/dom.ts and styles itself from src/UI/bootstrap-subset.css.
//
// How a bundle is built is shared with ShowTrak Server and Timers
// (shared/scripts/build-renderer.js); which bundles there are is this list.
// keepNames stays off, as this app has always built them: on, it would add a
// __name() call for every function to each bundle.
const path = require('node:path');
const Renderer = require('../shared/scripts/build-renderer');

const ROOT = path.resolve(__dirname, '..');

/** @type {Array<{name: string, entry: string, outfile: string, keepNames: boolean}>} */
const BUNDLES = [
  {
    name: 'Config window',
    entry: path.join(ROOT, 'src', 'UI', 'js', 'app', 'main.ts'),
    outfile: path.join(ROOT, 'dist', 'UI', 'js', 'app', 'main.js'),
    keepNames: false,
  },
  {
    name: 'Identify overlay',
    entry: path.join(ROOT, 'src', 'UI', 'js', 'app', 'identify-overlay.ts'),
    outfile: path.join(ROOT, 'dist', 'UI', 'js', 'app', 'identify-overlay.js'),
    keepNames: false,
  },
  {
    name: 'Launch countdown overlay',
    entry: path.join(ROOT, 'src', 'UI', 'js', 'app', 'launch-countdown.ts'),
    outfile: path.join(ROOT, 'dist', 'UI', 'js', 'app', 'launch-countdown.js'),
    keepNames: false,
  },
];

Renderer.main({ root: ROOT, bundles: BUNDLES });
