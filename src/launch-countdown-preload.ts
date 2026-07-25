// Preload for the launch countdown overlay window. Exposes a single, minimal
// API so the renderer can tell the main process the operator cancelled the
// pending run-on-launch script.
import { contextBridge, ipcRenderer } from 'electron';

import type { LaunchCountdownPreloadAPI } from './types/preload';

const API: LaunchCountdownPreloadAPI = {
  Cancel: () => ipcRenderer.invoke('LaunchCountdown:Cancel'),
};

contextBridge.exposeInMainWorld('LaunchCountdownAPI', API);
