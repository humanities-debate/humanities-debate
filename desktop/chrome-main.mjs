// Separate prototype launcher. Existing Electron/Whisper entry point is untouched.
import { app, utilityProcess, dialog } from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createChromeServer } from './chrome-server.mjs'
import { chromeProfilePaths } from './chrome-profile.mjs'
import { chromeStartupMessage } from './chrome-errors.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const profile = app.commandLine.getSwitchValue('profile') || 'A'
const verify = app.commandLine.hasSwitch('verify')
const paths = chromeProfilePaths({ root, appData: app.getPath('appData'), packaged: app.isPackaged, profile,
  verificationRoot: verify ? app.commandLine.getSwitchValue('verification-root') || undefined : undefined })
const { dataRoot } = paths
app.setPath('userData', paths.launcher)
app.setName(`Debate Chrome Prototype ${profile}`)
const single = app.requestSingleInstanceLock()
let worker, heartbeat, backendPort, chrome, server, stopping = false, stopped = false, changing = false
let phase = 'starting'
const secret = randomBytes(32).toString('hex'), pids = new Set()
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => new Set(['systemroot', 'windir', 'path', 'pathext', 'userprofile', 'appdata', 'localappdata', 'temp', 'tmp']).has(key.toLowerCase())))
const kill = pid => { if (Number.isInteger(pid)) spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) }
function startWorker() {
  phase = 'starting'; backendPort = undefined
  const current = worker = utilityProcess.fork(path.join(root, 'desktop-dist', 'worker.mjs'), [], { cwd: dataRoot, env, stdio: 'ignore', serviceName: 'Chrome debate backend' })
  current.on('message', message => {
    if (current !== worker) return
    if (message.type === 'child') { if (message.active) pids.add(message.pid); else pids.delete(message.pid) }
    if (message.type === 'ready') { backendPort = message.port; phase = 'ready' }
    if (message.type === 'status') { backendPort = undefined; phase = message.phase }
  })
  current.on('exit', () => { if (current === worker) { worker = undefined; backendPort = undefined; phase = 'error'; clearInterval(heartbeat); for (const pid of pids) kill(pid); pids.clear() } })
  const binary = app.isPackaged ? path.join(process.resourcesPath, 'codex/bin/codex.exe')
    : path.join(root, 'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe')
  current.postMessage({ type: 'init', settings: { dataRoot, secret, binary } })
  heartbeat = setInterval(() => current.postMessage({ type: 'heartbeat' }), 2000)
}
async function stopWorker() {
  backendPort = undefined; clearInterval(heartbeat)
  const current = worker
  if (!current) return
  await new Promise(resolve => {
    const timer = setTimeout(() => { for (const pid of pids) kill(pid); current.kill(); resolve() }, 10000)
    current.once('exit', () => { clearTimeout(timer); resolve() })
    current.postMessage({ type: 'shutdown' })
  })
  worker = undefined
}
async function shutdown() {
  if (stopping) return
  stopping = true
  server?.close(); server?.closeAllConnections()
  await stopWorker()
  if (chrome?.exitCode === null) kill(chrome.pid)
  stopped = true; app.quit()
}
app.on('window-all-closed', () => {})
app.on('before-quit', event => { if (!stopped) { event.preventDefault(); void shutdown() } })
if (!single) app.exit(0)
else app.whenReady().then(async () => {
try {
  await mkdir(dataRoot, { recursive: true })
  const identity = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true })
  const sid = identity.stdout?.match(/S-1-5-(?:\d+-)*\d+/)?.[0]
  if (!sid || spawnSync('icacls.exe', [dataRoot, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { stdio: 'ignore', windowsHide: true }).status !== 0) throw new Error('PROFILE_PERMISSIONS')
  const candidates = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean).map(dir => path.join(dir, 'Google/Chrome/Application/chrome.exe'))
  let binary
  for (const file of candidates) { try { await access(file); binary = file; break } catch { /* next standard location */ } }
  if (!binary) throw new Error('CHROME_NOT_INSTALLED')
  await access(path.join(root, 'dist/index.html')); await access(path.join(root, 'desktop-dist/worker.mjs'))
  const gateway = createChromeServer({ dist: path.join(root, 'dist'), portal: path.join(root, 'desktop/chrome'), secret,
    getBackend: () => backendPort, getStatus: () => ({ phase, profile }),
    action: async name => {
      if (name === 'exit') { setTimeout(() => void shutdown(), 100); return }
      if (name === 'cancel-login') { worker?.postMessage({ type: name }); return }
      if (changing || stopping) throw new Error('BUSY')
      if (name !== 'logout' && worker && !['ready', 'login-required', 'error'].includes(phase)) throw new Error('BUSY')
      changing = true
      try {
        if (name === 'logout') {
          await stopWorker()
          // Fixed, app-owned credential file only. Never the user's global Codex login.
          await rm(path.join(dataRoot, 'codex-auth/auth.json'), { force: true })
          await rm(path.join(dataRoot, 'codex-auth/auth.json.next'), { force: true })
          startWorker()
        } else if (!worker) startWorker()
        else worker.postMessage({ type: name })
      } finally { changing = false }
    } })
  server = gateway.server
  const portFile = path.join(dataRoot, 'port.json')
  let port = 0
  try { port = JSON.parse(await readFile(portFile, 'utf8')).port; if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('INVALID_PORT') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  port = server.address().port
  await writeFile(portFile, JSON.stringify({ port })) // Fixed origin preserves browser records; no silent port fallback.
  startWorker()
  const args = [`--user-data-dir=${paths.browser}`, '--no-first-run', '--no-default-browser-check', '--disable-background-mode', `--app=http://127.0.0.1:${port}/#${gateway.capability}`]
  // Explicit verification flags only, never enabled by normal shortcuts.
  if (verify) {
    args.push('--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1')
    if (app.commandLine.hasSwitch('fake-audio')) args.push('--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${path.join(root, '.codex-debate/korean-long.wav')}%noloop`)
  }
  chrome = spawn(binary, args, { windowsHide: true, stdio: 'ignore', env })
  chrome.once('error', () => void shutdown()); chrome.once('exit', () => void shutdown())
} catch (error) {
  dialog.showErrorBox('Chrome 검증판 실행 실패', chromeStartupMessage(error.code || error.message))
  await shutdown()
}
})
