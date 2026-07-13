// Preload for the launch countdown overlay window. Exposes a single, minimal
// API so the renderer can tell the main process the operator cancelled the
// pending run-on-launch script.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('LaunchCountdownAPI', {
  Cancel: () => ipcRenderer.invoke('LaunchCountdown:Cancel'),
});
