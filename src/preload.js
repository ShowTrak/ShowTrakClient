/**
 * Exposes a secure API to the renderer process via Electron's contextBridge.
 *
 * @namespace API
 * @property {function(): Promise<any>} Loaded - Invokes the 'Loaded' IPC event and returns a promise.
 * @property {function(): Promise<any>} GetVersion - Invokes the 'GetVersion' IPC event and returns a promise with the app version.
 * @property {function(): Promise<any>} Shutdown - Invokes the 'Shutdown' IPC event to shut down the application.
 * @property {function(): Promise<any>} Minimise - Invokes the 'Minimise' IPC event to minimize the application window.
 * @property {function(function(Profile: any)): void} SetProfile - Registers a callback to be called when the 'SetProfile' IPC event is received, passing the profile data.
 */
const { contextBridge, ipcRenderer } = require('electron');

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

function invoke(channel, ...args) {
  if (!INVOKE_CHANNELS.has(channel)) {
    throw new Error(`Blocked invoke channel: ${channel}`);
  }
  return ipcRenderer.invoke(channel, ...args);
}

function subscribe(channel, callback, mapper = (...payload) => payload) {
  if (!SUBSCRIBE_CHANNELS.has(channel)) {
    throw new Error(`Blocked subscribe channel: ${channel}`);
  }
  if (typeof callback !== 'function') {
    throw new TypeError(`Callback for ${channel} must be a function`);
  }

  const handler = (_event, ...payload) => {
    callback(...mapper(...payload));
  };

  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('API', {
  Loaded: async () => invoke('Loaded'),
  GetVersion: async () => invoke('GetVersion'),
  Shutdown: async () => invoke('Shutdown'),
  Minimise: async () => invoke('Minimise'),
  ResetClientFactoryDefaults: async () => invoke('Profile:FactoryReset'),
  SetManualServer: async (Host, Port) => invoke('Profile:SetManualServer', Host, Port),
  ClearManualServer: async () => invoke('Profile:ClearManualServer'),
  CheckForAppUpdates: async () => invoke('AppUpdate:Check'),
  InstallAppUpdate: async () => invoke('AppUpdate:Install'),
  OnAppUpdateStatus: (cb) => subscribe('AppUpdate:Status', cb),
  OnProcessMonitorStatus: (cb) => subscribe('ProcessMonitorStatus', cb),
  OnServerRecoveryStatus: (cb) => subscribe('ServerRecoveryStatus', cb),
  SetProfile: (Callback) => subscribe('SetProfile', Callback),
});
