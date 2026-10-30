// 克代同堂 浮窗：透明、置顶、没有边框的小窗，里面就是跑道小样（pages/track.html）
// 数据：Claude 里的克代同堂插件写 <Claude 文件夹>/clawdex/state.json，这里每秒看一次，变了就交给页面
// 页面里改了设置 / 要打开设置面板：写进 <Claude 文件夹>/clawdex/inbox.json，插件每两秒来取
// 关掉：右键小克「关掉浮窗」、右下角托盘图标「关掉浮窗」、Claude 里那一条上的「收起浮窗」（插件写 float-cmd.json）
// 不挡别的窗口：透明的地方鼠标直接穿过去；打开时不抢键盘（10-27 用户：挡住了语音输入）
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, shell } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const readline = require('readline')
const CONFIG = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const MOVE_PAGE = path.join(__dirname, '..', 'pages', 'move-list.html')

const DIR = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'clawdex')
const STATE = path.join(DIR, 'state.json')
const INBOX = path.join(DIR, 'inbox.json')
const PLACE = path.join(DIR, 'float-place.json')
const ALIVE = path.join(DIR, 'float-alive.json')
const CMD = path.join(DIR, 'float-cmd.json')
const ACCOUNTS = path.join(DIR, 'accounts.json')
const CLOSED = path.join(DIR, 'float-closed.json')
const PAGE = path.join(__dirname, '..', 'pages', 'track.html')
const SETTINGS = path.join(__dirname, '..', 'pages', 'settings.html')
const ICON = path.join(__dirname, 'icon.png')
const W = 440, H = 420

const ownsInstance = app.requestSingleInstanceLock()
if (!ownsInstance) app.quit()   // 只开一个

let win = null
let tray = null
let lastState = ''
let accountSnapshot = null
let activeClaudeRoot = null
let moveWin = null, moveContext = null, moveBusy = false
let currentLang = 'zh'
let desktopUsage = null

function claudeRoots() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'Claude-Data')
  return fs.readdirSync(base).filter(n => n.startsWith('claude_')).map(n => path.join(base, n))
}
function millis(value) {
  return typeof value === 'number' ? value : Date.parse(value) || 0
}

// 历史文件只读；只取当前安装目录的最后一次采样，不拼接别的安装的旧额度。
function pollUsage() {
  let next = null
  if (activeClaudeRoot) {
    const history = readJson(path.join(activeClaudeRoot, 'plan-usage-history.json'), null)
    const sample = history?.samples?.reduce((a, b) => millis(b.t) > millis(a?.t) ? b : a, null)
    if (sample && Number.isFinite(sample.t) && sample.u) next = {
      five: Number.isFinite(sample.u.fh) ? sample.u.fh : null,
      week: Number.isFinite(sample.u.sd) ? sample.u.sd : null,
      fiveAt: null, weekAt: null, at: sample.t, source: 'claude-history', org: sample.org,
    }
  }
  if (JSON.stringify(next) !== JSON.stringify(desktopUsage)) { desktopUsage = next; lastState = ''; tick() }
}
function withDesktopUsage(st) {
  let at = millis(st.usage?.at || st.at)
  if (!at) { try { at = fs.statSync(STATE).mtimeMs } catch {} }
  if (desktopUsage && desktopUsage.at > at) {
    const u = { ...desktopUsage }, p = st.usage, now = Date.now()
    const near = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 5
    if (p && near(p.five, u.five) && near(p.week, u.week) && millis(p.fiveAt) > now && millis(p.weekAt) > now) {   // 数字对得上 = 同一个号：Claude 自己的记录没有回满时间，借插件的（10-28 用户：回满时间查不到）
      u.fiveAt = p.fiveAt; u.weekAt = p.weekAt; delete u.source
    }
    return { ...st, usage: u }
  }
  return st
}

// 用户本人说的话：不算工具回传、系统附带的、搬家自己发的那几句（开对话时的交代、「另一个号那边的进度」）。
const MOVE_MARK = /从旧账号搬过来的对话|你在另一个号上又接着做了/
function humanText(row) {
  if (row.type !== 'user' || row.isMeta) return ''
  const c = row.message?.content
  const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text || '').join('\n') : ''
  return t.trim() && !t.trim().startsWith('<') && !MOVE_MARK.test(t) ? t : ''
}
// 大对话逐行读取，不把几百 MB 的聊天记录一次塞进内存。
// since 不为空时顺带看：上次搬完以后用户本人又说过话没有（AI 自己回的一句不算新进展；对话开头那句交代也不算）。
async function chatStatus(file, since = null) {
  let last = null, wrap = null, firstHuman = true, spoke = false
  const input = fs.createReadStream(file, { encoding: 'utf8' })
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      let row; try { row = JSON.parse(line) } catch { continue }
      if (row.type !== 'user' && row.type !== 'assistant') continue
      if (humanText(row)) {
        if (since !== null && !firstHuman && millis(row.timestamp) > since) spoke = true
        firstHuman = false
      }
      const content = row.message?.content
      if (typeof content === 'string') { if (content.trim()) last = row.type === 'assistant' ? 'text' : 'user'; continue }
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (row.type === 'assistant' && block.type === 'tool_use') {
          last = 'tool_use'
          if (/(?:^|__)wrap_up$/.test(block.name || '')) wrap = block.input || {}
        } else if (block.type === 'text' && block.text?.trim()) last = row.type === 'assistant' ? 'text' : 'user'
        // tool_result 只是工具回传，不代表 Claude 在调用之后又说过话。
      }
    }
    const status = last === 'tool_use' ? 'unfinished' : last === 'text' && wrap && !Object.prototype.hasOwnProperty.call(wrap, 'ask') ? 'done' : 'other'
    return since === null ? status : { status, spoke }
  } catch { return since === null ? 'unknown' : { status: 'unknown', spoke: true } } finally { lines.close(); input.destroy() }
}
async function buildMoveList(from, to, now = Date.now()) {
  if (!from || !to || from === to) throw new Error('missing-account')
  const records = new Map(), scopes = new Map()
  for (const root of claudeRoots()) {
    const base = path.join(root, 'claude-code-sessions', from)
    if (!fs.existsSync(base)) continue
    const prefs = readJson(path.join(root, 'claude_desktop_config.json'), {}).preferences?.epitaxyPrefs?.['dframe-group-scopes'] || {}
    for (const org of fs.readdirSync(base)) {
      const dir = path.join(base, org)
      if (!fs.statSync(dir).isDirectory()) continue
      let scope = prefs[`${from}/${org}`] || {}
      if (typeof scope === 'string') { try { scope = JSON.parse(scope) } catch { scope = {} } }
      scopes.set(`${root}/${org}`, scope)
      for (const file of fs.readdirSync(dir).filter(n => /^local_.*\.json$/.test(n))) {
        const row = readJson(path.join(dir, file), null)
        if (!row?.sessionId || row.isArchived || millis(row.lastActivityAt) < now - 7 * 86400000) continue
        const old = records.get(row.sessionId)
        if (!old || millis(old.lastActivityAt) < millis(row.lastActivityAt)) records.set(row.sessionId, { ...row, scope: `${root}/${org}` })
      }
    }
  }
  const pairs = readJson(path.join(path.dirname(CONFIG), '搬家', '搬家记录.json'), { pairs: [] }).pairs || []
  const projects = path.join(CONFIG, 'projects'), transcripts = new Map()
  // CLI 的项目文件夹命名会随版本变化，只按 cliSessionId 找对应文件。
  try { for (const folder of fs.readdirSync(projects)) {
    const dir = path.join(projects, folder)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const file of fs.readdirSync(dir).filter(n => n.endsWith('.jsonl'))) transcripts.set(file.slice(0, -6), path.join(dir, file))
  } } catch {}
  const groups = new Map()
  const groupFor = (row, seen = new Set()) => {
    if (!row || seen.has(row.sessionId)) return null
    seen.add(row.sessionId)
    const scope = scopes.get(row.scope) || {}
    const own = (scope.groups || []).find(g => g.id === scope.assignments?.['code:' + row.sessionId])
    if (own) return own
    const parent = records.get(row.spawnedFrom?.sessionId)
    return parent?.scope === row.scope ? groupFor(parent, seen) : null
  }
  for (const row of records.values()) {
    const pair = pairs.find(p => p.a === row.sessionId || p.b === row.sessionId)
    if (pair && millis(row.lastActivityAt) <= millis(pair.synced?.[row.sessionId])) continue
    let status = 'unknown'
    if (transcripts.has(row.cliSessionId)) {
      if (pair) {
        // 搬过的：只有用户本人在上次搬完以后又说过话，才算「有新进展」；否则跟没动过一样，不列
        const r = await chatStatus(transcripts.get(row.cliSessionId), millis(pair.synced?.[row.sessionId]))
        if (!r.spoke) continue
        status = r.status
      } else status = await chatStatus(transcripts.get(row.cliSessionId))
    }
    const scope = scopes.get(row.scope) || {}
    const group = groupFor(row)
    const folder = path.win32.basename((row.cwd || '').replace(/[\\/]+$/, '')) || row.cwd || ''
    const key = group ? row.scope + ':' + group.id : 'folder:' + (row.cwd || '')
    if (!groups.has(key)) groups.set(key, { id: key, name: group?.name || folder, custom: !!group, order: group ? scope.groups.indexOf(group) : 0, rows: [] })
    const tag = status === 'unfinished' ? status : pair ? 'updated' : status
    groups.get(key).rows.push({ id: row.sessionId, title: row.title || '', parent: row.spawnedFrom?.sessionId || null,
      at: millis(row.lastActivityAt), tag, checked: tag === 'unfinished' || tag === 'updated' })
  }
  const result = [...groups.values()].sort((a, b) => Number(b.custom) - Number(a.custom) || a.order - b.order || a.name.localeCompare(b.name))
  // 组内生成树；缺上级的作为根，循环关系也只列一次。
  for (const group of result) {
    const rows = group.rows.sort((a, b) => b.at - a.at), ids = new Set(rows.map(r => r.id)), seen = new Set(), flat = []
    const visit = (row, depth) => {
      if (seen.has(row.id)) return
      seen.add(row.id); flat.push({ ...row, depth })
      rows.filter(r => r.parent === row.id).forEach(r => visit(r, depth + 1))
    }
    rows.filter(r => !ids.has(r.parent)).forEach(r => visit(r, 0))
    rows.forEach(r => visit(r, 0)); group.rows = flat
  }
  return { from, to, groups: result }
}

function openMoveList(change) {
  if (!change.from || !change.to) return { ok: false, error: 'missing-account' }
  if (moveWin && !moveWin.isDestroyed()) { moveWin.show(); moveWin.focus(); moveWin.moveTop(); return { ok: true, selecting: true } }
  moveContext = { from: change.from, to: change.to, id: change.id }
  moveWin = new BrowserWindow({ width: 460, height: 640, frame: false, show: false, resizable: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true } })
  moveWin.loadFile(MOVE_PAGE)
  moveWin.once('ready-to-show', () => { moveWin.show(); moveWin.focus(); moveWin.moveTop() })
  moveWin.on('closed', () => { moveWin = null; moveContext = null })
  return { ok: true, selecting: true }
}
async function submitMove(ids) {
  if (!moveContext || moveBusy) return { ok: false, error: 'stale' }
  moveBusy = true
  const context = { ...moveContext }
  try {
    const registry = readJson(ACCOUNTS, {})
    if (registry.current !== context.to || registry.change?.id !== context.id) return { ok: false, error: 'stale' }
    const list = await buildMoveList(context.from, context.to)
    if (readJson(ACCOUNTS, {}).current !== context.to || moveContext?.id !== context.id) return { ok: false, error: 'stale' }
    const allowed = new Set(list.groups.flatMap(g => g.rows.map(r => r.id)))
    if (!Array.isArray(ids) || !ids.length || ids.some(id => !allowed.has(id))) return { ok: false, error: 'selection' }
    ids = [...new Set(ids)]
    fs.mkdirSync(DIR, { recursive: true })
    fs.writeFileSync(path.join(DIR, 'move-selection.json'), JSON.stringify({ from: context.from, to: context.to, ids, at: Date.now() }, null, 2))
    const url = 'claude://code/new?q=' + encodeURIComponent(`搬家：只接 move-selection.json 里选的 ${ids.length} 个`) + '&folder=' + encodeURIComponent(os.homedir())
    await shell.openExternal(url)
    if (win && !win.isDestroyed()) win.webContents.send('move-result', { ok: true })
    moveWin?.close()
    return { ok: true }
  } catch { return { ok: false, error: 'open-or-read' } } finally { moveBusy = false }
}

// 只读桌面应用的当前登录号，不依赖任何对话里的插件。多个安装目录取最新有效配置。
function pollAccount() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'Claude-Data')
  let candidates = []
  try {
    candidates = fs.readdirSync(base).filter(n => n.startsWith('claude_')).map(n => {
      const file = path.join(base, n, 'config.json')
      try { return { id: readJson(file, {}).lastKnownAccountUuid, at: fs.statSync(file).mtimeMs, root: path.dirname(file) } } catch { return {} }
    }).filter(c => typeof c.id === 'string' && c.id).sort((a, b) => b.at - a.at)
  } catch {}
  if (!candidates.length) return
  const id = candidates[0].id
  activeClaudeRoot = candidates[0].root
  const registry = readJson(ACCOUNTS, { accounts: [], current: null, change: null })
  if (!Array.isArray(registry.accounts)) return
  // 通用：小克第一次见到的号 = Claude 1，以后新出现的按顺序 Claude 2、3…（不写死任何人的号码）
  let account = registry.accounts.find(a => a.id === id)
  if (!account) {
    const next = Math.max(0, ...registry.accounts.map(a => Number(/^Claude (\d+)$/.exec(a.name)?.[1]) || 0)) + 1
    account = { id, name: 'Claude ' + next, ai: 'Claude' }
    registry.accounts.push(account)
  }
  const old = registry.current
  account.id = id
  if (old && old !== id && !id.startsWith(old)) {
    registry.change = { id: Date.now() + ':' + id, from: old, to: id, account: account.name, answered: false }
    if (moveWin && !moveWin.isDestroyed()) moveWin.close()
    desktopUsage = null
  }
  registry.current = id
  fs.mkdirSync(DIR, { recursive: true })
  const text = JSON.stringify(registry)
  if (text !== JSON.stringify(readJson(ACCOUNTS, null))) fs.writeFileSync(ACCOUNTS, text)
  const snapshot = { account: { ai: 'Claude', label: account.name }, accounts: registry.accounts, change: registry.change }
  pollUsage()
  if (JSON.stringify(snapshot) === JSON.stringify(accountSnapshot)) return
  accountSnapshot = snapshot
  lastState = ''
  for (const w of [win, setWin]) if (w && !w.isDestroyed()) w.webContents.send('account', snapshot)
  tick()
}

async function answerAccount(changeId, bring) {
  const registry = readJson(ACCOUNTS, null)
  if (!registry?.change || registry.change.id !== changeId || registry.change.answered) return
  registry.change.answered = true
  fs.writeFileSync(ACCOUNTS, JSON.stringify(registry))
  if (accountSnapshot?.change?.id === changeId) accountSnapshot.change.answered = true
  if (!bring) return { ok: true }
  return openMoveList(registry.change)
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function place() {   // 上次放在哪；第一次放屏幕右边偏上（别压住 Claude 底下的输入框）
  const p = readJson(PLACE, null)
  if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return p
  const a = screen.getPrimaryDisplay().workArea
  return { x: a.x + a.width - W - 16, y: a.y + Math.round(a.height * 0.25) }
}

function tick() {   // 每秒：把新数据交给页面、报个平安、看插件有没有叫它关掉
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(ALIVE, JSON.stringify({ at: Date.now() }))
  const cmd = readJson(CMD, null)
  if (cmd && cmd.close) { try { fs.unlinkSync(CMD) } catch {} quit(); return }
  if (cmd && cmd.shot) {   // 让 Claude 看见浮窗现在的样子（Claude 截不了别的程序的窗口）
    try { fs.unlinkSync(CMD) } catch {}
    for (const [w, name] of [[win, 'float-shot.png'], [setWin, 'settings-shot.png']]) {
      if (w && !w.isDestroyed()) w.webContents.capturePage().then(img => fs.writeFileSync(path.join(DIR, name), img.toPNG()))
    }
  }
  let text = ''
  try { text = fs.readFileSync(STATE, 'utf8') } catch { text = '{}' }
  if (text === lastState || !win) return
  lastState = text
  let st
  try { st = withDesktopUsage(JSON.parse(text)) } catch { return }   // 写到一半的文件，下一秒再读
  if (accountSnapshot) Object.assign(st, { account: accountSnapshot.account, claudeAccount: accountSnapshot.account, accounts: accountSnapshot.accounts })
  for (const w of [win, setWin]) if (w && !w.isDestroyed()) w.webContents.send('state', st)
}

// 设置页小窗：浮窗里点「管理队友」打开（手绘设置页 pages/settings.html），只开一个
let setWin = null
function openSettings() {
  if (setWin && !setWin.isDestroyed()) { setWin.show(); setWin.focus(); return }
  setWin = new BrowserWindow({
    width: 460, height: 640, frame: false, alwaysOnTop: false, resizable: true, title: '克代同堂 · 设置',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  })
  setWin.loadFile(SETTINGS)
  setWin.once('ready-to-show', () => { setWin.show(); setWin.focus(); setWin.moveTop() })   // 打开时放到最前面（10-28 用户：设置看不到）
  setWin.webContents.on('did-finish-load', () => { lastState = ''; tick(); if (accountSnapshot) setWin.webContents.send('account', accountSnapshot) })
  setWin.on('closed', () => { setWin = null })
}

function quit() {
  try { fs.unlinkSync(ALIVE) } catch {}
  app.quit()
}

app.whenReady().then(() => {
  if (!ownsInstance) return
  fs.mkdirSync(DIR, { recursive: true })
  try { fs.unlinkSync(CLOSED) } catch {} // 开机或手动重新打开，只清本次退出标记。
  try { fs.unlinkSync(CMD) } catch {}   // 上次没用掉的「关掉」不算数，不然一打开就被关
  const p = place()
  win = new BrowserWindow({
    x: p.x, y: p.y, width: W, height: H, show: false,
    frame: false, transparent: true, resizable: false, alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, backgroundThrottling: false },   // 长按要准时：别让系统放慢计时器
  })
  win.setAlwaysOnTop(true, 'floating')
  const focusLog = what => { try { fs.appendFileSync(path.join(DIR, 'float-focus.log'), new Date().toISOString() + ' ' + what + '\n') } catch {} }   // 记下拿到 / 失去焦点（10-28：切到 Edge 收不起来，查原因用）
  win.on('focus', () => focusLog('focus'))
  win.on('blur', () => focusLog('blur'))
  win.setIgnoreMouseEvents(true, { forward: true })   // 先全部穿透，鼠标碰到小克这些东西时页面再说
  win.loadFile(PAGE)
  win.once('ready-to-show', () => win.showInactive())   // 不抢键盘
  win.webContents.on('did-finish-load', () => { lastState = ''; tick(); if (accountSnapshot) win.webContents.send('account', accountSnapshot) })
  setInterval(tick, 1000)
  pollAccount()
  setInterval(pollAccount, 5000)
  win.on('moved', () => {
    const [x, y] = win.getPosition()
    fs.writeFileSync(PLACE, JSON.stringify({ x, y }))
  })
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ height: 16 }))
  trayMenu('zh')
})

// 托盘图标的菜单跟着浮窗的语言走
function trayMenu(l) {
  const en = l === 'en'
  tray.setToolTip(en ? 'Clawdex' : '克代同堂')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: en ? 'Move back to the right' : '放回屏幕右边', click: () => { try { fs.unlinkSync(PLACE) } catch {} const q = place(); win.setPosition(q.x, q.y) } },
    { label: en ? 'Quit' : '退出', click: userQuit },
  ]))
}
ipcMain.on('lang', (_e, l) => {
  currentLang = l === 'en' ? 'en' : 'zh'
  if (tray) trayMenu(currentLang)
  if (moveWin && !moveWin.isDestroyed()) moveWin.webContents.send('move-lang', currentLang)
})

app.on('second-instance', () => { if (win) win.showInactive() })
app.on('window-all-closed', quit)

function tell(action) {   // 要告诉插件的事，排进 inbox.json
  fs.mkdirSync(DIR, { recursive: true })
  const list = readJson(INBOX, [])
  list.push({ ...action, at: Date.now() })
  fs.writeFileSync(INBOX, JSON.stringify(list.slice(-50)))
}
function userQuit() {
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(CLOSED, JSON.stringify({ at: Date.now() }))
  tell({ type: 'closed' })
  quit()
}
ipcMain.handle('account-answer', (_e, id, bring) => answerAccount(id, bring === true))
ipcMain.handle('move-list', async e => {
  if (e.sender !== moveWin?.webContents || !moveContext) return { error: 'stale' }
  try { return { ...await buildMoveList(moveContext.from, moveContext.to), lang: currentLang } }
  catch { return { error: 'read', lang: currentLang } }
})
ipcMain.handle('move-submit', (e, ids) => e.sender === moveWin?.webContents ? submitMove(ids) : { ok: false, error: 'stale' })
ipcMain.on('move-close', e => { if (e.sender === moveWin?.webContents) moveWin.close() })
ipcMain.on('send', (_e, action) => tell(action))
ipcMain.on('move', (_e, dx, dy) => {
  if (!win) return
  const [x, y] = win.getPosition()
  win.setPosition(Math.round(x + dx), Math.round(y + dy))
})
ipcMain.on('through', (_e, yes) => { if (win) win.setIgnoreMouseEvents(!!yes, { forward: true }) })
ipcMain.on('focus', () => { if (win && !win.isDestroyed() && !win.isFocused()) { try { fs.appendFileSync(path.join(DIR, 'float-focus.log'), new Date().toISOString() + ' ask-focus\n') } catch {} win.focus() } })   // 点到小克才拿焦点（平时 showInactive 不抢键盘）；拿到焦点后切到别的程序才会收到 blur，展开的那块才会收起（10-28 用户：切到 Edge 没收起；照 menubar 库的做法）

// 长按小克拿起来：窗口每帧跟着鼠标走，松手放下（主程序直接读鼠标位置，拖快了也不丢）
let follow = null
ipcMain.on('drag-start', () => {
  if (!win || follow) return
  const c = screen.getCursorScreenPoint(), [x, y] = win.getPosition()
  const off = { x: c.x - x, y: c.y - y }
  follow = setInterval(() => {
    const p = screen.getCursorScreenPoint()
    win.setPosition(p.x - off.x, p.y - off.y)
  }, 16)
})
ipcMain.on('drag-end', () => {
  if (!follow) return
  clearInterval(follow)
  follow = null
  const [x, y] = win.getPosition()
  fs.writeFileSync(PLACE, JSON.stringify({ x, y }))
})
ipcMain.on('close', userQuit)
ipcMain.on('open-settings', openSettings)
