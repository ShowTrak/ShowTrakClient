// Preload for the launch countdown overlay window. Exposes a single, minimal
// API so the renderer can tell the main process the operator cancelled the
// pending run-on-launch script.
import { contextBridge, ipcRenderer } from 'electron';

import type { LaunchCountdownPreloadAPI, OverlayInvokeMap } from '@showtrak/protocol/client';

const API: LaunchCountdownPreloadAPI = {
  // Answered by the 'LaunchCountdown:Cancel' handler in src/main/ipc-handlers.ts.
  Cancel: () =>
    ipcRenderer.invoke('LaunchCountdown:Cancel') as Promise<
      OverlayInvokeMap['LaunchCountdown:Cancel']['Result']
    >,
};

contextBridge.exposeInMainWorld('LaunchCountdownAPI', API);
