// Preload for the identify overlay window. Exposes a single, minimal API so the
// overlay renderer can tell the main process the user dismissed the overlay.
import { contextBridge, ipcRenderer } from 'electron';

import type { IdentifyPreloadAPI, OverlayInvokeMap } from '@showtrak/protocol/client';

const API: IdentifyPreloadAPI = {
  // Answered by the 'Identify:Close' handler in src/main/ipc-handlers.ts.
  Close: () =>
    ipcRenderer.invoke('Identify:Close') as Promise<OverlayInvokeMap['Identify:Close']['Result']>,
};

contextBridge.exposeInMainWorld('IdentifyAPI', API);
