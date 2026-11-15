// 8F internal candidate. Independent app ID, data root and installer from 0.0.7.
import { app, safeStorage, shell, dialog } from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, lstat, access, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { createChromeServer } from './chrome-server.mjs'
import { siwcPaths, SIWC_APP_NAME, accountScope, publicAccounts, publicAuthError } from './siwc-accounts.mjs'
import { chromeStartupMessage } from './chrome-errors.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const profile = app.commandLine.getSwitchValue('profile') || 'A'
const paths = siwcPaths({ root, appData: app.getPath('appData'), packaged: app.isPackaged, profile })
app.setPath('userData', paths.launcher)
app.setName(`Humanities Debate SIWC ${profile}`)
const packageInfo = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
app.setAppUserModelId(packageInfo.desktopAppId || 'local.humanities.debate.siwc.ux.internal')
const single = app.requestSingleInstanceLock()
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => new Set(['systemroot', 'windir', 'path', 'pathext', 'userprofile', 'appdata', 'localappdata', 'temp', 'tmp']).has(key.toLowerCase())))
let client, store, backend, runtime, gateway, chrome, chromeBinary, changing = false, stopping = false, stopped = false, busyLogin
let phase = 'starting', authError, activeScope, activeBrowserRoot, accounts = [], revocation
let epoch = 0
const recoveries = new Set()
const secret = randomBytes(32).toString('hex')
const verify = app.commandLine.hasSwitch('verify') && !app.isPackaged
async function diagnostic(stage, error) {
  if (!verify) return
  await mkdir(path.join(root, '.codex-debate'), { recursive: true })
  await writeFile(path.join(root, '.codex-debate/siwc-8f-startup.json'), JSON.stringify({ stage, ...(error ? { error: publicAuthError(error) } : {}) }))
}
async function secureDirectory(directory) {
  await mkdir(directory, { recursive: true })
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('UNSAFE_DATA_PATH')
  const identity = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true })
  const sid = identity.stdout?.match(/S-1-5-(?:\d+-)*\d+/)?.[0]
  if (identity.status !== 0 || !sid || spawnSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`],
    { windowsHide: true, stdio: 'ignore' }).status !== 0) throw new Error('PROFILE_PERMISSIONS')
}
const encryption = { id: 'electron-windows-dpapi-async-v1', isAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
  encrypt: text => safeStorage.encryptStringAsync(text), decrypt: async bytes => (await safeStorage.decryptStringAsync(Buffer.from(bytes))).result }
const scope = async () => { const session = await client.getSession(); return store.withLock(async () => accountScope(await store.read(), session)) }
async function refreshAccounts() { accounts = publicAccounts(await client.listProfiles()) }
function status() { return { phase, profile, accounts, activeAccount: accounts.find(item => item.id === clientSession?.profileId),
  error: authError, revocation, official: true } }
let clientSession
async function stopBackend() {
  epoch++
  runtime?.cancel(); runtime = undefined
  const old = backend; backend = undefined
  await old?.close()
}
async function closeChrome() {
  const old = chrome; chrome = undefined
  if (old?.exitCode === null) {
    spawnSync('taskkill.exe', ['/PID', String(old.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  }
}
async function closeGateway() {
  const old = gateway; gateway = undefined
  if (old) { old.server.closeAllConnections(); await new Promise(resolve => old.server.close(resolve)) }
}
async function storedPort(directory) {
  try {
    const { port } = JSON.parse(await readFile(path.join(directory, 'port.json'), 'utf8'))
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('INVALID_PORT')
    return port
  } catch (error) { if (error.code === 'ENOENT') return 0; throw error }
}
async function openBrowser(directory) {
  if (stopping) return
  await secureDirectory(directory)
  const port = await storedPort(directory)
  await closeChrome(); await closeGateway()
  const current = gateway = createChromeServer({ dist: path.join(root, 'dist'), portal: path.join(root, 'desktop/chrome-siwc'),
    getBackend: () => phase === 'ready' ? backend?.server.address()?.port : undefined, getStatus: status, secret,
    extraActions: ['add-account', 'select-account', 'usage', 'recover-legacy'], allowApp: () => phase === 'ready', action })
  await new Promise((resolve, reject) => { current.server.once('error', reject); current.server.listen(port, '127.0.0.1', resolve) })
  const selectedPort = current.server.address().port
  await writeFile(path.join(directory, 'port.json'), JSON.stringify({ port: selectedPort }))
  activeBrowserRoot = directory
  const args = [`--user-data-dir=${path.join(directory, 'browser')}`, '--no-first-run', '--no-default-browser-check', '--disable-background-mode',
    `--app=http://127.0.0.1:${selectedPort}/#${current.capability}`]
  if (verify) args.push('--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1')
  const child = chrome = spawn(chromeBinary, args, { env, stdio: 'ignore', windowsHide: false })
  child.once('error', () => { if (child === chrome) void shutdown() })
  // closeChrome clears the owned reference before intentional account switches.
  // A user closing the current window must also stop the app during sign-in.
  child.once('exit', () => { if (child === chrome) void shutdown() })
}
async function connect() {
  await stopBackend()
  clientSession = await client.getSession()
  await refreshAccounts()
  if (clientSession.status !== 'connected') { phase = 'login-required'; activeScope = undefined; return }
  if (!clientSession.sharing) { phase = 'sharing-required'; activeScope = undefined; return }
  const rows = await client.listModels()
  const key = await scope()
  const { createSIWCRuntime, siwcModelChoices } = await import(pathToFileURL(path.join(root, 'desktop-dist/siwc/runtime.mjs')).href)
  const { createDebateServer, defaultModelSettings } = await import(pathToFileURL(path.join(root, 'desktop-dist/siwc/backend.mjs')).href)
  const models = siwcModelChoices(rows)
  if (!models.length) throw new Error('MODELS_UNAVAILABLE')
  const currentEpoch = epoch
  runtime = createSIWCRuntime({ client, models, accountScope: key, getAccountScope: async () => currentEpoch === epoch ? scope() : null,
    onDiagnostic: value => { if (verify) void writeFile(path.join(root, '.codex-debate/siwc-8f-request-error.json'), JSON.stringify(value)).catch(() => {}) },
    onAuthError: code => { authError = code; phase = 'login-required' } })
  backend = createDebateServer(runtime.generate, { models, defaultSettings: defaultModelSettings(models), analyze: runtime.analyze, desktopSecret: secret })
  await new Promise((resolve, reject) => { backend.server.once('error', reject); backend.server.listen(0, '127.0.0.1', resolve) })
  activeScope = key; phase = 'ready'; authError = undefined
}
async function activate() {
  await connect()
  const directory = activeScope ? path.join(paths.accounts, activeScope) : paths.guest
  // Cookies, local API tokens, origin and Chrome storage switch together.
  if (directory !== activeBrowserRoot) await openBrowser(directory)
}
async function recoverLegacy() {
  const port = await storedPort(paths.legacy)
  if (!port) throw new Error('NO_LEGACY_RECORDS')
  await access(path.join(paths.legacy, 'browser'))
  const recovery = createChromeServer({ dist: path.join(root, 'dist'), portal: path.join(root, 'desktop/chrome-recovery'),
    getBackend: () => undefined, getStatus: () => ({ phase: 'recovery' }), secret: randomBytes(32).toString('hex'),
    allowApp: () => false, action: async () => {} })
  await new Promise((resolve, reject) => { recovery.server.once('error', reject); recovery.server.listen(port, '127.0.0.1', resolve) })
  const child = spawn(chromeBinary, [`--user-data-dir=${path.join(paths.legacy, 'browser')}`, '--no-first-run', '--disable-background-mode',
    `--app=http://127.0.0.1:${port}/#${recovery.capability}`], { env, windowsHide: false, stdio: 'ignore' })
  const entry = { child, recovery }; recoveries.add(entry)
  const cleanup = () => { recovery.server.closeAllConnections(); recovery.server.close(); recoveries.delete(entry) }
  child.once('exit', cleanup); child.once('error', cleanup)
}
async function action(name, body) {
  if (name === 'cancel-login') { client.cancelSignIn(); return { ok: true } }
  if (name === 'usage') { await shell.openExternal('https://chatgpt.com/settings/usage'); return { ok: true } }
  if (name === 'exit') { setTimeout(() => void shutdown(), 100); return { ok: true } }
  if (changing || stopping) return { error: 'BUSY' }
  if (name === 'select-account' && !accounts.some(item => item.id === body?.profileId && !item.pending)) return { error: 'INVALID_PROFILE' }
  if (name === 'recover-legacy') { try { await recoverLegacy(); return { ok: true } } catch { return { error: 'LEGACY_CLOSE_OLD_APP_OR_NOT_FOUND' } } }
  changing = true
  phase = name === 'login' || name === 'add-account' ? 'logging-in' : 'starting'
  // Respond before terminating the old browser/gateway. Never return credentials.
  busyLogin = (async () => {
    await new Promise(resolve => setTimeout(resolve, 150))
    if (stopping) return
    await stopBackend()
    if (name !== 'reconnect') {
      await closeChrome(); await closeGateway()
      await openBrowser(paths.guest)
    }
    try {
      authError = undefined
      if (name === 'login' || name === 'add-account') await client.signIn({ newProfile: name === 'add-account', reconsent: clientSession?.status === 'connected' && !clientSession.sharing })
      else if (name === 'select-account') await client.selectProfile(body.profileId)
      else if (name === 'logout') {
        const connected = clientSession?.status === 'connected'
        try { await client.disconnect(); revocation = connected ? 'confirmed' : undefined } catch (error) { revocation = 'unconfirmed'; throw error }
      }
      await activate()
    } catch (error) {
      await stopBackend(); activeScope = undefined
      authError = publicAuthError(error); phase = 'login-required'
      clientSession = await client.getSession(); await refreshAccounts()
      if (activeBrowserRoot !== paths.guest) await openBrowser(paths.guest)
    } finally { changing = false }
  })().catch(async error => { authError = publicAuthError(error); phase = 'error'; changing = false })
  return { ok: true }
}
async function shutdown() {
  if (stopping) return
  stopping = true; phase = 'stopping'
  client?.cancelSignIn()
  await stopBackend()
  await Promise.race([busyLogin?.catch(() => {}), new Promise(resolve => setTimeout(resolve, 8000))])
  await closeGateway(); await closeChrome()
  for (const { child, recovery } of recoveries) {
    recovery.server.closeAllConnections(); recovery.server.close()
    if (child.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  }
  stopped = true; app.quit()
}
app.on('window-all-closed', () => {})
app.on('before-quit', event => { if (!stopped) { event.preventDefault(); void shutdown() } })
if (!single) app.exit(0)
else app.whenReady().then(async () => {
  try {
    await diagnostic('secure-storage')
    await secureDirectory(paths.dataRoot); await secureDirectory(paths.auth)
    if (!(await encryption.isAvailable())) throw new Error('ENCRYPTION_UNAVAILABLE')
    await diagnostic('find-chrome')
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean)) {
      const candidate = path.join(base, 'Google/Chrome/Application/chrome.exe')
      try { await access(candidate); chromeBinary = candidate; break } catch { /* next */ }
    }
    if (!chromeBinary) throw new Error('CHROME_NOT_INSTALLED')
    await diagnostic('load-sdk')
    const { createChatGPT, ConnectionStore } = await import(pathToFileURL(path.join(root, 'desktop-dist/siwc/sdk.mjs')).href)
    store = new ConnectionStore(paths.auth, encryption)
    client = createChatGPT({ appName: SIWC_APP_NAME, appId: 'humanities-debate-siwc', storageDir: paths.auth, redirectPort: 0, sendHostId: true,
      credentialEncryption: encryption, openBrowser: async value => {
        const url = new URL(value)
        if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/api/accounts/authorize' || url.username || url.password) throw new Error('UNSAFE_LOGIN_URL')
        await shell.openExternal(url.href)
      } })
    client.subscribe(session => { clientSession = session })
    await diagnostic('connect')
    try { await activate() } catch (error) { authError = publicAuthError(error); phase = 'login-required'; await refreshAccounts() }
    if (!chrome) await openBrowser(paths.guest)
    await diagnostic('chrome-launched')
  } catch (error) {
    await diagnostic('startup-failed', error).catch(() => {})
    dialog.showErrorBox('공식 ChatGPT 연결판 실행 실패', chromeStartupMessage(error.code || error.message))
    await shutdown()
  }
})
