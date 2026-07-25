/**
 * Exposes a secure API to the renderer process via Electron's contextBridge.
 *
 * The two allowlists below are the security boundary: the renderer can only
 * reach channels named here. `ClientPreloadAPI` (src/types/preload.d.ts) is the
 * shared contract — the object handed to `exposeInMainWorld` is checked against
 * it, and the renderer consumes the same interface via its `Window` augmentation.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import type { ManualServer } from './types/client';
import type { ClientPreloadAPI, IpcResult, LoadedSnapshot, Unsubscribe } from './types/preload';

const INVOKE_CHANNELS = new Set([
  'Loaded',
  'GetVersion',
  'Shutdown',
  'Minimise',
  'Profile:FactoryReset',
  'Profile:SetManualServer',
  'Profile:ClearManualServer',
  'AppUpdate:Check',
  'AppUpdate:Install',
]);

const SUBSCRIBE_CHANNELS = new Set([
  'SetProfile',
  'AppUpdate:Status',
  'ProcessMonitorStatus',
  'ServerRecoveryStatus',
]);

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  if (!INVOKE_CHANNELS.has(channel)) {
    throw new Error(`Blocked invoke channel: ${channel}`);
  }
  return ipcRenderer.invoke(channel, ...args);
}

function subscribe(
  channel: string,
  callback: (...payload: never[]) => void,
  mapper: (...payload: unknown[]) => unknown[] = (...payload) => payload
): Unsubscribe {
  if (!SUBSCRIBE_CHANNELS.has(channel)) {
    throw new Error(`Blocked subscribe channel: ${channel}`);
  }
  if (typeof callback !== 'function') {
    throw new TypeError(`Callback for ${channel} must be a function`);
  }

  const handler = (_event: IpcRendererEvent, ...payload: unknown[]) => {
    (callback as (...args: unknown[]) => void)(...mapper(...payload));
  };

  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const API: ClientPreloadAPI = {
  Loaded: async () => (await invoke('Loaded')) as IpcResult<LoadedSnapshot>,
  GetVersion: async () => (await invoke('GetVersion')) as string,
  Shutdown: async () => invoke('Shutdown'),
  Minimise: async () => invoke('Minimise'),
  ResetClientFactoryDefaults: async () => invoke('Profile:FactoryReset'),
  SetManualServer: async (Host, Port) =>
    (await invoke('Profile:SetManualServer', Host, Port)) as IpcResult<ManualServer>,
  ClearManualServer: async () => invoke('Profile:ClearManualServer'),
  CheckForAppUpdates: async () => invoke('AppUpdate:Check'),
  InstallAppUpdate: async () => invoke('AppUpdate:Install'),
  OnAppUpdateStatus: (cb) => subscribe('AppUpdate:Status', cb as (...p: never[]) => void),
  OnProcessMonitorStatus: (cb) => subscribe('ProcessMonitorStatus', cb as (...p: never[]) => void),
  OnServerRecoveryStatus: (cb) => subscribe('ServerRecoveryStatus', cb as (...p: never[]) => void),
  SetProfile: (Callback) => subscribe('SetProfile', Callback as (...p: never[]) => void),
};

contextBridge.exposeInMainWorld('API', API);
