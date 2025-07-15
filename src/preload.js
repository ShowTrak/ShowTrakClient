const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('API', {
    GetVersion: async () => ipcRenderer.invoke('GetVersion'),
    Shutdown: async () => ipcRenderer.invoke('Shutdown'),
    Minimise: async () => ipcRenderer.invoke('Minimise'),
})