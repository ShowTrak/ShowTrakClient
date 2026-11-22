// Removes Chromium's UI translations (~45 MB) that this app never shows, called
// from forge.config.ts (packageAfterExtract) on the freshly extracted Electron.
//
// Shared with ShowTrak Server and Timers: shared/scripts/trim-electron-locales.js
// says what is kept and why.
module.exports = require('../shared/scripts/trim-electron-locales');
