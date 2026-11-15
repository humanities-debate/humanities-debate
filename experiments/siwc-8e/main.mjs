// Independent experiment. Does not import the app's Codex runtime or read its profiles.
import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron'
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile, rename, lstat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { APP_NAME, SMOKE_QUESTION, allowedBrowserUrl, publicSession, safeError, selectSmokeModel, verifiedRecordScope, onceOnlySmoke } from './policy.mjs'

const directory = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(directory, '../..')
const dataRoot = path.join(root, '.codex-debate/siwc-8e-data')
app.setPath('userData', path.join(dataRoot, 'electron'))
app.setName(APP_NAME)
app.setAppUserModelId('local.humanities.debate.siwc8e')
const single = app.requestSingleInstanceLock()
let window, client, store, currentOperation, requestController, busy = false, quitting = false
let models = [], smokeAttempted = false
const report = { prototype: '8E', date: new Date().toISOString(), sdk: '@siwc/local@0.1.0',
  login: 'NOT_TESTED', sharing: false, verifiedScope: false, inference: 'NOT_TESTED',
  differentAccounts: 'UNVERIFIED', expiry: 'UNVERIFIED', remoteRevocation: 'UNVERIFIED', publicReleaseReady: false }
const encryption = {
  id: 'electron-windows-dpapi-async-v1',
  isAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
  encrypt: text => safeStorage.encryptStringAsync(text),
  decrypt: async bytes => (await safeStorage.decryptStringAsync(Buffer.from(bytes))).result,
}
let reportQueue = Promise.resolve()
const saveReport = () => {
  const serialized = JSON.stringify(report, null, 2)
  const task = reportQueue.catch(() => {}).then(async () => {
    await writeFile(path.join(dataRoot, 'report.json.next'), serialized)
    await rename(path.join(dataRoot, 'report.json.next'), path.join(dataRoot, 'report.json'))
  })
  reportQueue = task
  return task
}
async function secureDirectory(target) {
  await mkdir(target, { recursive: true })
  if ((await lstat(target)).isSymbolicLink()) throw new Error('UNSAFE_DATA_PATH')
  const identity = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true })
  const sid = identity.stdout?.match(/S-1-5-(?:\d+-)*\d+/)?.[0]
  if (identity.status !== 0 || !sid || spawnSync('icacls.exe', [target, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`],
    { windowsHide: true, stdio: 'ignore' }).status !== 0) throw new Error('DATA_PERMISSIONS_FAILED')
}
async function snapshot() {
  const session = await client.getSession()
  return { session: publicSession(session), profiles: (await client.listProfiles()).map(item => ({ id: item.id, label: item.label,
    status: item.status, pending: item.pending === true })), models, smokeAttempted, report }
}
async function ownerScope() {
  const session = await client.getSession()
  return store.withLock(async () => verifiedRecordScope(await store.read(), session))
}
const smoke = onceOnlySmoke(async model => {
  const scope = await ownerScope()
  const controller = requestController = new AbortController()
  const started = performance.now()
  try {
    const result = await client.streamResponse({ model, input: SMOKE_QUESTION,
      instructions: '한국어 토론 연습용 질문 한 문장만 제안하세요. 개인 정보는 요청하지 마세요.', signal: controller.signal })
    controller.signal.throwIfAborted()
    if (scope !== await ownerScope()) throw new Error('ACCOUNT_CHANGED')
    if (!result.text.trim()) throw new Error('EMPTY_RESPONSE')
    // One synthetic probe in an account-derived namespace, never legacy debate data.
    const namespace = path.join(dataRoot, 'records', scope)
    await mkdir(namespace, { recursive: true })
    await writeFile(path.join(namespace, 'probe.json'), JSON.stringify({ schemaVersion: 1, purpose: '8E synthetic probe',
      question: SMOKE_QUESTION, text: result.text, model, createdAt: new Date().toISOString() }, null, 2))
    Object.assign(report, { inference: 'SUCCESS', requestedModel: model, elapsedSeconds: Number(((performance.now() - started) / 1000).toFixed(3)),
      text: result.text, verifiedScope: true, processingModel: 'NOT_REPORTED_BY_SDK' })
  } finally { requestController = undefined }
})

async function action(value) {
  if (!value || typeof value !== 'object' || !['status', 'login', 'add-account', 'select', 'models', 'smoke', 'logout', 'usage', 'cancel'].includes(value.action)) throw new Error('INVALID_ACTION')
  if (value.action === 'cancel') { client.cancelSignIn(); requestController?.abort(); return { cancelled: true } }
  if (value.action === 'usage') { await shell.openExternal(allowedBrowserUrl('https://chatgpt.com/settings/usage')); return { opened: true } }
  if (value.action === 'status') return snapshot()
  if (busy) throw new Error('BUSY')
  busy = true
  try {
    if (value.action === 'login' || value.action === 'add-account') {
      report.login = 'ATTEMPTED'
      const session = await client.signIn({ newProfile: value.action === 'add-account' })
      report.login = session.status === 'connected' ? 'SUCCESS' : 'NOT_CONNECTED'
      report.sharing = session.sharing
      report.verifiedScope = session.sharing && Boolean(await ownerScope())
      models = [] // Catalog from a previous account must not be reused.
      if (session.sharing) models = await client.listModels()
    } else if (value.action === 'select') {
      const profiles = await client.listProfiles()
      if (!profiles.some(item => item.id === value.profileId && !item.pending)) throw new Error('INVALID_PROFILE')
      await client.selectProfile(value.profileId)
      models = []
      report.activeScopeVerified = (await client.getSession()).sharing ? Boolean(await ownerScope()) : false
    } else if (value.action === 'models') {
      models = await client.listModels()
    } else if (value.action === 'smoke') {
      if (!models.length || !models.some(item => item.slug === value.model)) throw new Error('INVALID_MODEL')
      smokeAttempted = true
      report.inference = 'ATTEMPTED'
      await smoke(value.model)
    } else if (value.action === 'logout') {
      models = []
      const hadSession = await store.withLock(async () => {
        const saved = await store.read()
        const profile = saved?.profiles.find(item => item.id === saved.activeProfileId)
        return Boolean(profile?.credentials || profile?.pendingRefresh)
      })
      try { await client.disconnect(); report.remoteRevocation = hadSession ? 'CONFIRMED_BY_ENDPOINT' : 'NOT_REQUIRED_NO_SAVED_SESSION' }
      catch (error) { report.remoteRevocation = 'UNCONFIRMED'; throw error }
    }
    await saveReport()
    const state = await snapshot()
    return { ...state, preferredModel: selectSmokeModel(models)?.slug }
  } catch (error) {
    report.lastError = safeError(error)
    if (value.action === 'smoke') report.inference = 'FAILED'
    if ((value.action === 'login' || value.action === 'add-account') && report.login !== 'SUCCESS') report.login = 'FAILED'
    await saveReport()
    return { error: safeError(error), ...(await snapshot()) }
  } finally { busy = false }
}
async function quit() {
  if (quitting) return
  quitting = true
  client?.cancelSignIn(); requestController?.abort()
  await Promise.race([currentOperation?.catch(() => {}), new Promise(resolve => setTimeout(resolve, 8000))])
  app.exit(0)
}
app.on('window-all-closed', () => { void quit() })
app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void quit() } })
app.on('second-instance', () => { if (window && !window.isDestroyed()) { window.show(); window.focus() } })
if (!single) app.exit(app.commandLine.hasSwitch('verify-encryption') ? 2 : 0)
else app.whenReady().then(async () => {
  try {
    if (process.platform !== 'win32') throw new Error('WINDOWS_REQUIRED')
    await secureDirectory(dataRoot)
    if (!(await encryption.isAvailable())) throw new Error('ENCRYPTION_UNAVAILABLE')
    const { createChatGPT, ConnectionStore } = await import(pathToFileURL(path.join(root, '.codex-debate/siwc-8e-build/official-sdk.mjs')).href)
    const authDir = path.join(dataRoot, 'official-auth')
    await secureDirectory(authDir)
    store = new ConnectionStore(authDir, encryption)
    client = createChatGPT({ appName: APP_NAME, appId: 'humanities-debate-siwc-8e', storageDir: authDir,
      redirectPort: 0, sendHostId: true, credentialEncryption: encryption,
      openBrowser: url => shell.openExternal(allowedBrowserUrl(url)) })
    report.encryptionAvailable = true
    report.existingCredentialsAccessed = false
    await saveReport()
    // A preflight never logs in or calls inference; only validates OS encryption and SDK loading.
    if (app.commandLine.hasSwitch('verify-encryption')) {
      const sentinel = '8E synthetic encryption probe'
      const bytes = await encryption.encrypt(sentinel)
      if (await encryption.decrypt(bytes) !== sentinel || Buffer.from(bytes).includes(Buffer.from(sentinel))) throw new Error('ENCRYPTION_ROUNDTRIP_FAILED')
      report.encryptionRoundtrip = true
      await saveReport(); app.exit(0); return
    }
    const page = pathToFileURL(path.join(directory, 'index.html')).href
    window = new BrowserWindow({ width: 860, height: 740, show: false, autoHideMenuBar: true,
      webPreferences: { preload: path.join(directory, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } })
    window.on('show', () => { report.windowVisible = true; void saveReport().catch(() => {}) })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    ipcMain.handle('siwc-8e', (event, value) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== page) throw new Error('FORBIDDEN')
      const operation = action(value).catch(error => ({ error: safeError(error) }))
      if (!['status', 'cancel', 'usage'].includes(value?.action)) currentOperation = operation
      return operation
    })
    client.subscribe(session => { if (window && !window.isDestroyed()) window.webContents.send('siwc-8e-state', publicSession(session)) })
    await window.loadFile(path.join(directory, 'index.html'))
    report.windowLoaded = true
    report.bridgeAvailable = await window.webContents.executeJavaScript('typeof window.siwcPrototype?.action === "function"')
    report.uiStructure = await window.webContents.executeJavaScript('({ heading: document.querySelector("h1")?.textContent.includes("8E"), buttons: document.querySelectorAll("button").length, bodyTextLength: document.body.innerText.length })')
    window.show(); window.focus()
    report.windowVisible = window.isVisible()
    await saveReport()
    setTimeout(() => { report.windowVisible = !window.isDestroyed() && window.isVisible(); void saveReport().catch(() => {}) }, 1500)
  } catch (error) {
    report.startupError = safeError(error)
    await saveReport().catch(() => {})
    app.exit(1)
  }
})
// Do not emit raw SDK errors, OAuth URLs, token values or account details to stdout/stderr.
process.on('unhandledRejection', () => { void quit() })
