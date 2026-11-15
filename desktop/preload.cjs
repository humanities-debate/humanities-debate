const { contextBridge, ipcRenderer } = require('electron')
// No tokens, paths, generic IPC, filesystem or shell API in the renderer.
contextBridge.exposeInMainWorld('debateDesktop', Object.freeze({
  status: () => ipcRenderer.invoke('desktop:status'),
  login: () => ipcRenderer.invoke('desktop:login'),
  reconnect: () => ipcRenderer.invoke('desktop:reconnect'),
  cancelLogin: () => ipcRenderer.invoke('desktop:cancel-login'),
  transcribe: (id, pcm) => ipcRenderer.invoke('speech:transcribe', id, pcm),
  cancelSpeech: id => ipcRenderer.invoke('speech:cancel', id),
  onStatus: callback => {
    const listener = (_event, status) => callback(status)
    ipcRenderer.on('desktop:status', listener)
    return () => ipcRenderer.removeListener('desktop:status', listener)
  },
}))
