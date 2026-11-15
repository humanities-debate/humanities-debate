// Run with Electron. Isolated app profile, synthetic records, no login or AI calls.
import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureRecord, fixtureFeedback } from '../tests/fixtures/feedback.mjs'
import '../desktop/main.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const parent = path.join(root, '.codex-debate', 'desktop-check')
const report = { success: false, checks: [], speech: null }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, ms = 30000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(100) }
  throw new Error('Desktop check timeout')
}
app.on('browser-window-created', (_event, window) => window.hide())
async function verify() {
await mkdir(parent, { recursive: true })
await app.whenReady()
try {
  const window = await until(() => BrowserWindow.getAllWindows()[0])
  const evaluate = script => window.webContents.executeJavaScript(script)
  await until(async () => { try { return await evaluate("Boolean(window.debateDesktop && document.querySelector('.participant-row'))") } catch { return false } })
  const isolation = window.webContents.getLastWebPreferences()
  assert.equal(isolation.nodeIntegration, false)
  assert.equal(isolation.contextIsolation, true)
  assert.equal(isolation.sandbox, true)
  assert.equal(await evaluate('typeof window.require'), 'undefined')
  report.checks.push('Electron renderer isolation and existing React UI')
  await until(async () => ['login-required', 'error'].includes((await evaluate('window.debateDesktop.status()')).phase))
  assert.equal((await evaluate('window.debateDesktop.status()')).phase, 'login-required')
  report.checks.push('Automatic worker startup and fresh user login-required state')
  assert.equal(await evaluate("fetch('/api/models',{headers:{'X-Debate-Client':'local-ui'}}).then(r=>r.status)"), 503)
  assert.equal(await evaluate("fetch('https://example.com').then(()=>false,()=>true)"), true)
  assert.equal(await evaluate("window.debateDesktop.status('unexpected').then(()=>true,()=>false)"), true) // bridge accepts no caller-supplied args
  report.checks.push('AI API unavailable before login; external renderer network blocked; fixed IPC')
  const record = fixtureRecord(); record.feedback = fixtureFeedback(record)
  const key = 'skhynix-debate:record:' + record.id
  await evaluate(`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(JSON.stringify(record))})`)
  await window.webContents.session.flushStorageData()
  window.webContents.reload()
  await until(async () => { try { return await evaluate('Boolean(window.debateDesktop && document.querySelector(".participant-row"))') } catch { return false } })
  assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(key)}))`), record)
  report.checks.push('Record and feedback preserved after renderer reload')
  report.speech = await evaluate("({speechRecognition:!!(window.SpeechRecognition||window.webkitSpeechRecognition),getUserMedia:!!navigator.mediaDevices?.getUserMedia,hardwareTested:false})")
  report.success = true
} catch (error) { report.error = error.message; process.exitCode = 1 }
finally {
  await writeFile(path.join(parent, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
  app.quit()
}
}
void verify()
