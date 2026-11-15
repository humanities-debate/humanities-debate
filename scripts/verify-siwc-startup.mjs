// Packaged executable smoke test only. No login, credential import, or AI requests.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const speechFix = process.argv.includes('--speech-fix')
const profile = `8F-Smoke-${Date.now()}`
const exe = path.resolve(speechFix ? 'release-siwc-speech/win-unpacked/HumanitiesDebateSIWCSpeech.exe' : 'release-siwc/win-unpacked/HumanitiesDebateSIWCUX.exe')
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => new Set(['systemroot', 'windir', 'path', 'pathext', 'userprofile', 'appdata', 'localappdata', 'temp', 'tmp', 'programfiles', 'programfiles(x86)']).has(key.toLowerCase())))
const child = spawn(exe, [`--profile=${profile}`], { env, windowsHide: true, stdio: 'ignore' })
let port, chromePid, exited = false
child.once('exit', () => { exited = true })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
try {
  const portFile = path.join(process.env.APPDATA, 'HumanitiesDebateSIWC/profiles', profile, 'guest/port.json')
  for (let i = 0; i < 50; i++) {
    try { port = JSON.parse(await readFile(portFile, 'utf8')).port; break } catch { await delay(500) }
    if (exited) throw new Error('PACKAGED_APP_EXITED_BEFORE_STARTUP')
  }
  assert.ok(Number.isInteger(port), 'Packaged app did not create its loopback gateway')
  const origin = `http://127.0.0.1:${port}`
  const page = await fetch(origin, { signal: AbortSignal.timeout(5000) })
  assert.equal(page.status, 200); assert.match(await page.text(), /Continue with ChatGPT/)
  const html = await (await fetch(origin)).text()
  assert.match(html, /id="settings-panel"[^>]*hidden/)
  assert.doesNotMatch(html, /id="open"|토론 화면 열기/)
  for (const route of ['/api/session', '/launcher/status', '/app']) assert.equal((await fetch(origin + route)).status, 403)
  const duplicate = spawn(exe, [`--profile=${profile}`], { env, windowsHide: true, stdio: 'ignore' })
  const duplicateCode = await Promise.race([new Promise(resolve => duplicate.once('exit', resolve)), delay(10000).then(() => 'timeout')])
  if (duplicateCode === 'timeout') spawnSync('taskkill.exe', ['/PID', String(duplicate.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  assert.equal(duplicateCode, 0, 'Duplicate launcher did not stop itself')
  const ownedChrome = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object ParentProcessId -eq ${child.pid} | Select-Object -ExpandProperty ProcessId`],
    { windowsHide: true, encoding: 'utf8', timeout: 15000 })
  const ids = ownedChrome.stdout.trim().split(/\s+/).filter(value => /^\d+$/.test(value))
  assert.equal(ids.length, 1, 'Could not establish ownership of the test Chrome process')
  chromePid = ids[0]
  spawnSync('taskkill.exe', ['/PID', chromePid, '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  for (let i = 0; i < 30 && !exited; i++) await delay(500)
  assert.ok(exited, 'Launcher did not exit after its own Chrome closed')
  await assert.rejects(fetch(origin, { signal: AbortSignal.timeout(2000) }))
  console.log(JSON.stringify({ packagedExecutableStarted: true, bundledSDKAndDPAPIInitialized: true, chromeChildLaunched: true,
    loopbackPortalServed: true, unauthenticatedAPIDenied: true, compactSettingsAndNoOpenButton: true, duplicateInstanceExited: true, serverAndLauncherStoppedWithChrome: true,
    actualLoginAndMicrophoneInInstalledApp: 'UNVERIFIED', noAIRequests: true }))
} finally {
  if (!exited) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
}
