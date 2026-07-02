// Preload for the identify overlay window. Exposes a single, minimal API so the
// overlay renderer can tell the main process the user dismissed the overlay.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('IdentifyAPI', {
  Close: () => ipcRenderer.invoke('Identify:Close'),
});
