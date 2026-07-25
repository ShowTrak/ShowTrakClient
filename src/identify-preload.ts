// Preload for the identify overlay window. Exposes a single, minimal API so the
// overlay renderer can tell the main process the user dismissed the overlay.
import { contextBridge, ipcRenderer } from 'electron';

import type { IdentifyPreloadAPI } from './types/preload';

const API: IdentifyPreloadAPI = {
  Close: () => ipcRenderer.invoke('Identify:Close'),
};

contextBridge.exposeInMainWorld('IdentifyAPI', API);
