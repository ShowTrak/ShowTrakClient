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
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('API', {
    Loaded: async () => ipcRenderer.invoke('Loaded'),
    GetVersion: async () => ipcRenderer.invoke('GetVersion'),
    Shutdown: async () => ipcRenderer.invoke('Shutdown'),
    Minimise: async () => ipcRenderer.invoke('Minimise'),
    SetProfile: (Callback) => ipcRenderer.on('SetProfile', (_event, Profile) => {
        Callback(Profile)
    }),
})