// 页面里能用的：window.clawdex.onState(收到插件数据) / send(告诉插件) / moveBy(挪窗口) / through(鼠标穿透) / close(关掉浮窗)
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('clawdex', {
  onState: cb => ipcRenderer.on('state', (_e, st) => cb(st)),
  onAccount: cb => ipcRenderer.on('account', (_e, st) => cb(st)),
  answerAccount: (id, bring) => ipcRenderer.invoke('account-answer', id, bring),
  moveList: () => ipcRenderer.invoke('move-list'),
  submitMove: ids => ipcRenderer.invoke('move-submit', ids),
  closeMove: () => ipcRenderer.send('move-close'),
  onMoveResult: cb => ipcRenderer.on('move-result', (_e, result) => cb(result)),
  onMoveLang: cb => ipcRenderer.on('move-lang', (_e, lang) => cb(lang)),
  send: action => ipcRenderer.send('send', action),
  moveBy: (dx, dy) => ipcRenderer.send('move', dx, dy),
  through: yes => ipcRenderer.send('through', yes),
  focus: () => ipcRenderer.send('focus'),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragEnd: () => ipcRenderer.send('drag-end'),
  openSettings: () => ipcRenderer.send('open-settings'),
  lang: l => ipcRenderer.send('lang', l),
  close: () => ipcRenderer.send('close'),
})
