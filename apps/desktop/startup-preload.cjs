const { contextBridge, ipcRenderer } = require('electron')

const IPC_STARTUP_RETRY = 'meng:startup-retry'
const IPC_STARTUP_QUIT = 'meng:startup-quit'

contextBridge.exposeInMainWorld('mengStartup', {
  retry: () => ipcRenderer.send(IPC_STARTUP_RETRY),
  quit: () => ipcRenderer.send(IPC_STARTUP_QUIT),
})
