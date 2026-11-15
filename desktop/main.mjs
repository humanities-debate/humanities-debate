import { app, BrowserWindow, ipcMain, protocol, session, utilityProcess, dialog } from 'electron'
import { randomBytes } from 'node:crypto'
import { readFile, mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { APP_URL, CSP, isAppUrl, assetPath, apiAllowed, permissionAllowed, statusMessage } from './security.mjs'
import { createWhisperService, validSpeechId } from './whisper.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
// Stable name/origin keep localStorage across upgrades. Never use the Chrome profile.
app.setName('인문학 토론 연습')
const requestedProfile = app.commandLine.getSwitchValue('user-data-dir')
const dataRoot = requestedProfile && path.isAbsolute(requestedProfile) ? requestedProfile : path.join(app.getPath('appData'), 'HumanitiesDebatePractice')
app.setPath('userData', dataRoot)
protocol.registerSchemesAsPrivileged([{ scheme: 'debate', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])
const single = app.requestSingleInstanceLock()
let window, worker, port, heartbeat, quitTimer
let quitting = false, finished = false
let speechService
let speechClosing = false
let state = { phase: 'starting', message: 'AI 서버를 준비하고 있습니다.' }
const secret = randomBytes(32).toString('hex')
const cliPids = new Set()
function update(next) {
  state = next
  if (!window?.isDestroyed()) window?.webContents.send('desktop:status', state)
}
function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return
  const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  child.on('error', () => {})
}
function startWorker() {
  if (worker || quitting) return
  port = undefined
  update({ phase: 'starting', message: 'AI 서버를 준비하고 있습니다.' })
  const allowed = new Set(['systemroot', 'windir', 'path', 'pathext', 'userprofile', 'appdata', 'localappdata', 'temp', 'tmp'])
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase())))
  worker = utilityProcess.fork(path.join(root, 'desktop-dist', 'worker.mjs'), [], { cwd: dataRoot, env, stdio: 'ignore', serviceName: 'Debate AI backend' })
  const current = worker
  current.on('message', message => {
    if (worker !== current) return
    if (message.type === 'child' && Number.isInteger(message.pid)) {
      if (message.active) cliPids.add(message.pid); else cliPids.delete(message.pid)
    } else if (message.type === 'ready' && Number.isInteger(message.port)) {
      port = message.port
      update({ phase: 'ready', message: 'ChatGPT 연결 준비 완료' })
    } else if (message.type === 'status') {
      port = undefined
      update({ phase: message.phase, message: message.phase === 'logging-in' ? '열린 기본 브라우저에서 자신의 ChatGPT 계정으로 로그인해 주세요.'
        : message.phase === 'starting' ? 'AI 서버를 준비하고 있습니다.' : statusMessage(message.code) })
    }
  })
  current.on('exit', () => {
    if (worker !== current) return
    clearInterval(heartbeat)
    worker = undefined
    port = undefined
    for (const pid of cliPids) killTree(pid)
    cliPids.clear()
    if (quitting) { clearTimeout(quitTimer); finished = true; app.quit() }
    else update({ phase: 'error', message: statusMessage('BACKEND_EXIT') })
  })
  const binary = app.isPackaged ? path.join(process.resourcesPath, 'codex', 'bin', 'codex.exe')
    : path.join(root, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe')
  current.postMessage({ type: 'init', settings: { dataRoot, binary, secret } })
  heartbeat = setInterval(() => current.postMessage({ type: 'heartbeat' }), 2000)
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
async function handleRequest(request) {
  if (!isAppUrl(request.url)) return json(403, { error: 'FORBIDDEN' })
  const url = new URL(request.url)
  if (url.pathname.startsWith('/api/')) {
    if (!apiAllowed(request.method, url.pathname) || url.search) return json(404, { error: 'NOT_FOUND' })
    if (!port || state.phase !== 'ready') return json(503, { error: 'CHATGPT_LOGIN_REQUIRED' })
    let body
    if (request.method === 'POST') {
      if (request.headers.get('content-type') !== 'application/json') return json(400, { error: 'INVALID_REQUEST' })
      const parts = []; let size = 0
      for await (const part of request.body ?? []) { size += part.length; if (size > 1_000_000) return json(413, { error: 'CONTEXT_LIMIT' }); parts.push(part) }
      body = Buffer.concat(parts)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}${url.pathname}`, { method: request.method, body,
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(155_000)]),
        headers: { 'Content-Type': 'application/json', 'X-Debate-Client': 'local-ui', 'X-Desktop-Secret': secret,
          'X-Debate-Token': request.headers.get('x-debate-token') || '' }, redirect: 'error' })
      return new Response(await response.arrayBuffer(), { status: response.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
    } catch { return json(503, { error: 'AI_UNAVAILABLE' }) }
  }
  if (request.method !== 'GET') return json(405, { error: 'INVALID_REQUEST' })
  const file = assetPath(path.join(root, 'dist'), request.url)
  if (!file) return json(403, { error: 'FORBIDDEN' })
  try {
    const type = ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' })[path.extname(file)] || 'application/octet-stream'
    return new Response(await readFile(file), { headers: { 'Content-Type': type, 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' } })
  } catch { return json(404, { error: 'NOT_FOUND' }) }
}
if (!single) app.quit()
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus() })
  app.whenReady().then(async () => {
    await mkdir(dataRoot, { recursive: true })
    speechService = createWhisperService({ dataRoot, assets: app.isPackaged
      ? path.join(process.resourcesPath, 'whisper') : path.join(root, 'desktop-assets', 'whisper') })
    const trustedSpeech = event => event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame && isAppUrl(event.senderFrame.url)
    ipcMain.handle('speech:transcribe', (event, id, pcm) => {
      if (!trustedSpeech(event)) throw new Error('FORBIDDEN')
      return speechService.transcribe(id, pcm)
    })
    ipcMain.handle('speech:cancel', (event, id) => {
      if (!trustedSpeech(event) || !validSpeechId(id)) throw new Error('FORBIDDEN')
      speechService.cancel(id)
    })
    protocol.handle('debate', handleRequest)
    session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details) => contents === window?.webContents && permissionAllowed(permission, origin, details.mediaType ? [details.mediaType] : []))
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback(contents === window?.webContents && details.isMainFrame && permissionAllowed(permission, details.requestingUrl, details.mediaTypes))
    })
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !isAppUrl(details.url) }))
    for (const action of ['status', 'login', 'reconnect', 'cancel-login']) ipcMain.handle(`desktop:${action}`, (event, ...args) => {
      if (args.length || event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || !isAppUrl(event.senderFrame.url)) throw new Error('FORBIDDEN')
      if (action === 'status') return state
      if (state.phase === 'starting' || (state.phase === 'logging-in' && action !== 'cancel-login')) return state
      if (!worker) startWorker()
      else worker.postMessage({ type: action })
      return state
    })
    window = new BrowserWindow({ width: 1366, height: 900, minWidth: 800, minHeight: 600, title: '인문학 토론 연습',
      autoHideMenuBar: true, backgroundColor: '#F8F9FB',
      webPreferences: { preload: path.join(here, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: !app.isPackaged } })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event, url) => { if (url !== APP_URL) event.preventDefault() })
    window.webContents.on('will-attach-webview', event => event.preventDefault())
    window.webContents.on('destroyed', () => speechService?.cancel())
    window.webContents.on('render-process-gone', () => speechService?.cancel())
    window.webContents.on('render-process-gone', () => { void dialog.showMessageBox(window, { message: '화면이 중단되었습니다. 앱을 종료하고 다시 실행해 주세요. 저장된 기록은 유지됩니다.' }); app.quit() })
    await window.loadURL(APP_URL)
    startWorker()
  }).catch(() => { dialog.showErrorBox('앱 시작 실패', '앱 파일과 사용자 데이터 폴더 접근 권한을 확인해 주세요.'); app.quit() })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', event => {
    if (speechClosing) { event.preventDefault(); return }
    if (speechService) {
      event.preventDefault()
      const stoppingSpeech = speechService
      speechService = undefined
      speechClosing = true
      void stoppingSpeech.close().catch(() => {}).finally(() => { speechClosing = false; app.quit() })
      return
    }
    if (finished || !worker) return
    event.preventDefault()
    if (quitting) return
    quitting = true
    clearInterval(heartbeat)
    worker.postMessage({ type: 'shutdown' })
    quitTimer = setTimeout(() => {
      for (const pid of cliPids) killTree(pid)
      killTree(worker?.pid)
      worker?.kill()
      finished = true
      app.quit()
    }, 10000)
  })
}
