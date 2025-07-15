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