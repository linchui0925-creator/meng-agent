const { contextBridge, ipcRenderer } = require('electron')

const IPC_INVOKE = 'meng:invoke'
const IPC_EVENT = 'meng:event'
const IPC_STATE = 'meng:state'
const IPC_MANIFEST = 'meng:manifest'

let state = 'connecting'
const stateListeners = new Set()

ipcRenderer.on(IPC_STATE, (_event, next) => {
  state = next
  for (const fn of stateListeners) fn(next)
})

contextBridge.exposeInMainWorld('mengDesktop', {
  invoke: (op, payload) => ipcRenderer.invoke(IPC_INVOKE, op, payload),
  subscribe: (fn) => {
    const listener = (_event, event) => fn(event)
    ipcRenderer.on(IPC_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC_EVENT, listener)
  },
  state: () => state,
  onStateChange: (fn) => {
    stateListeners.add(fn)
    return () => stateListeners.delete(fn)
  },
  manifest: () => ipcRenderer.sendSync(IPC_MANIFEST),
})
