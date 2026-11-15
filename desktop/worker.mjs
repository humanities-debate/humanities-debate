import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { childEnvironment } from '../scripts/codex-smoke-policy.mjs'

// SDK 0.166.0 does not set windowsHide. Scope this adapter to this dedicated worker.
// Also track every spawned CLI so the main process can clean up after worker failure.
const spawn = childProcess.spawn
const children = new Set()
const post = message => process.parentPort?.postMessage(message)
childProcess.spawn = function (file, args, options) {
  const child = spawn(file, args, { ...options, windowsHide: true })
  if (child.pid) { children.add(child); post({ type: 'child', pid: child.pid, active: true }) }
  child.once('close', () => { children.delete(child); if (child.pid) post({ type: 'child', pid: child.pid, active: false }) })
  return child
}
syncBuiltinESMExports()

let settings, runtime, backend, loginChild, loginTimer
let busy = false, closing = false, heartbeat = Date.now()
const status = (phase, code) => post({ type: 'status', phase, code })
async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true })
  const identity = childProcess.spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true })
  const sid = identity.stdout?.match(/S-1-5-(?:\d+-)*\d+/)?.[0]
  if (!sid || identity.status !== 0) throw new Error('RUNTIME_PERMISSIONS')
  const acl = childProcess.spawnSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { windowsHide: true, stdio: 'ignore' })
  if (acl.status !== 0) throw new Error('RUNTIME_PERMISSIONS')
}
async function stopRuntime() {
  const oldBackend = backend, oldRuntime = runtime
  backend = runtime = undefined
  try { await oldBackend?.close() } finally { await oldRuntime?.cleanup() }
}
async function connect() {
  if (closing) return
  status('starting')
  await stopRuntime()
  try {
    const { createCodexRuntime } = await import('./runtime.mjs')
    const { createDebateServer } = await import('../server/http.mjs')
    runtime = await createCodexRuntime(settings.dataRoot, { sourceHome: settings.authHome, binary: settings.binary, persistAuth: true })
    if (closing) { await stopRuntime(); return }
    backend = createDebateServer(runtime.generate, { models: runtime.models, defaultSettings: runtime.defaultSettings,
      analyze: runtime.analyze, desktopSecret: settings.secret })
    await new Promise((resolve, reject) => {
      backend.server.once('error', reject)
      backend.server.listen(0, '127.0.0.1', resolve)
    })
    post({ type: 'ready', port: backend.server.address().port })
  } catch (error) {
    await stopRuntime().catch(() => {})
    if (!closing) status(error.code === 'CHATGPT_LOGIN_REQUIRED' ? 'login-required' : 'error', error.code || error.message)
  }
}
async function login() {
  status('logging-in')
  await stopRuntime()
  const env = childEnvironment(process.env, settings.authHome, settings.temp)
  const args = ['-c', 'forced_login_method="chatgpt"', '-c', 'cli_auth_credentials_store="file"', 'login']
  const code = await new Promise(resolve => {
    loginChild = childProcess.spawn(settings.binary, args, { env, cwd: settings.loginWork, stdio: 'ignore' })
    loginChild.once('error', () => resolve(-1))
    loginChild.once('close', resolve)
    loginTimer = setTimeout(() => { loginChild?.kill(); status('error', 'LOGIN_TIMEOUT') }, 300_000)
  })
  clearTimeout(loginTimer)
  loginChild = undefined
  if (closing) return
  if (code === 0) await connect()
  else status('login-required', 'LOGIN_FAILED')
}
async function shutdown() {
  if (closing) return
  closing = true
  clearInterval(watchdog)
  clearTimeout(loginTimer)
  loginChild?.kill()
  const force = setTimeout(() => { for (const child of children) child.kill(); process.exit(1) }, 8000)
  try { await stopRuntime(); post({ type: 'stopped' }) } finally { clearTimeout(force); process.exit(0) }
}
const watchdog = setInterval(() => {
  if (Date.now() - heartbeat > 12000) void shutdown()
}, 2000)
process.parentPort.on('message', async ({ data }) => {
  if (data?.type === 'heartbeat') { heartbeat = Date.now(); return }
  if (data?.type === 'shutdown') { void shutdown(); return }
  if (data?.type === 'cancel-login') { loginChild?.kill(); return }
  if (busy || closing) return
  busy = true
  try {
    if (data?.type === 'init' && !settings) {
      settings = data.settings
      settings.authHome = path.join(settings.dataRoot, 'codex-auth')
      settings.temp = path.join(settings.dataRoot, 'runtime-temp')
      settings.loginWork = path.join(settings.dataRoot, 'login-work')
      for (const directory of [settings.authHome, settings.temp, settings.loginWork, path.join(settings.dataRoot, '.codex-debate')]) await privateDirectory(directory)
      // Only this app's abandoned runtime directories; never browser profiles or user records.
      const parent = path.join(settings.dataRoot, '.codex-debate')
      for (const entry of await readdir(parent, { withFileTypes: true })) {
        if (entry.isDirectory() && /^run-[a-zA-Z0-9]+$/.test(entry.name)) await rm(path.join(parent, entry.name), { recursive: true, force: true })
      }
      await connect()
    } else if (settings && data?.type === 'login') await login()
    else if (settings && data?.type === 'reconnect') await connect()
  } catch (error) { if (!closing) status('error', error.code || error.message) }
  finally { busy = false }
})
