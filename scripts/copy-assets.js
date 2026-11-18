// Copies static runtime assets that TypeScript does NOT compile into the dist/
// output so that __dirname-relative paths in the compiled main process resolve
// identically to the original src/ layout.
//
// TypeScript (tsconfig.json) compiles the Node-side code (src/Modules, src/main,
// the preloads) into dist/. The renderer UI and image/icon assets are
// intentionally excluded from compilation and must be copied verbatim so the
// packaged app keeps working exactly as before — see the __dirname lookups in
// src/main.ts (window icon, tray image, UI/index.html) and the overlay modules.
const fs = require('node:fs');
const path = require('node:path');

const SRC_ROOT = path.resolve(__dirname, '..', 'src');
const DIST_ROOT = path.resolve(__dirname, '..', 'dist');

// Exactly what ships, relative to src/. This used to copy src/UI and src/images
// wholesale, which put 7.4 MB of vendored jQuery and Bootstrap (every build of
// both, source maps and RTL variants included) into every install for a window
// that used one stylesheet. A file missing from here is missing from the app, so
// a new asset must be listed — and the build fails loudly if one listed is gone.
const ASSET_FILES = [
  // The config window, and the stylesheet purged from Bootstrap for it.
  'UI/index.html',
  'UI/index.css',
  'UI/bootstrap-subset.css',
  // The overlays carry their styles inline.
  'UI/identify-overlay.html',
  'UI/launch-countdown-overlay.html',
  // Window and tray icons (src/main/app-window.ts, src/main/tray.ts) and the
  // logo the windows show. icon.icns is read from src/ by the packager.
  'images/icon.ico',
  'images/icon.png',
  'images/trayTemplate.png',
  'images/ui-icon.png',
];

function main() {
  for (const relative of ASSET_FILES) {
    const source = path.join(SRC_ROOT, relative);
    const destination = path.join(DIST_ROOT, relative);
    if (!fs.existsSync(source)) {
      throw new Error(`[copy-assets] Listed asset is missing: src/${relative}`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  console.log(`[copy-assets] Copied ${ASSET_FILES.length} static assets into dist/`);
}

main();
