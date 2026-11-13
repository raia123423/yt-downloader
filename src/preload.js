const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('app:init'),
  getInfo: (url) => ipcRenderer.invoke('info:get', url),

  addToQueue: (items) => ipcRenderer.invoke('queue:add', items),
  cancel: (id) => ipcRenderer.invoke('queue:cancel', id),
  cancelAll: () => ipcRenderer.invoke('queue:cancelAll'),
  retry: (id) => ipcRenderer.invoke('queue:retry', id),
  remove: (id) => ipcRenderer.invoke('queue:remove', id),
  clearFinished: () => ipcRenderer.invoke('queue:clearFinished'),

  removeHistory: (id) => ipcRenderer.invoke('history:remove', id),
  clearHistory: () => ipcRenderer.invoke('history:clear'),

  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  chooseFolder: () => ipcRenderer.invoke('dialog:chooseFolder'),
  chooseCookiesFile: () => ipcRenderer.invoke('dialog:chooseCookiesFile'),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  updateYtDlp: () => ipcRenderer.invoke('ytdlp:update'),
  checkLatest: () => ipcRenderer.invoke('ytdlp:checkLatest'),

  onQueueUpdate: on('queue:update'),
  onQueueRemoved: on('queue:removed'),
  onHistoryChanged: on('history:changed'),
  onUpdateLog: on('ytdlp:updateLog'),
  onYtdlpLatest: on('ytdlp:latest'),
  onClipboardLink: on('clipboard:link'),
});
