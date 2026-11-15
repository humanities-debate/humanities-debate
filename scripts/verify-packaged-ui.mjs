// Packaged EXE, isolated profile, synthetic records; no login/AI/microphone calls.
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fixtureRecord, fixtureFeedback } from '../tests/fixtures/feedback.mjs'
const root = process.cwd()
await mkdir('.codex-debate', { recursive: true })
const profile = await mkdtemp(path.join(root, '.codex-debate', 'packaged-ui-'))
const exe = path.join(root, 'release', 'win-unpacked', 'HumanitiesDebate.exe')
const env = { ...process.env }
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key]
const report = { success: false, checks: [], profile }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, ms = 30000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { try { const value = await check(); if (value) return value } catch { /* startup */ } await delay(100) }
  throw new Error('Packaged UI timeout: ' + report.stage)
}
let child, socket, exited, sessionId, nextId = 0
const pending = new Map()
function command(method, params = {}, targetSession = sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, 10000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params, ...(targetSession ? { sessionId: targetSession } : {}) }))
  })
}
async function launch() {
  await rm(path.join(profile, 'DevToolsActivePort'), { force: true })
  child = spawn(exe, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'], { env, windowsHide: true, stdio: 'ignore' })
  exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', () => resolve(-1)) })
  const endpoint = await until(async () => {
    const [port, route] = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/)
    return `ws://127.0.0.1:${port}${route}`
  })
  socket = new WebSocket(endpoint)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), task = pending.get(message.id)
    if (!task) return
    pending.delete(message.id); clearTimeout(task.timer)
    if (message.error) task.reject(new Error(message.error.message)); else task.resolve(message.result)
  })
  sessionId = undefined
  const target = await until(async () => (await command('Target.getTargets')).targetInfos.find(item => item.type === 'page' && item.url === 'debate://app/'))
  sessionId = (await command('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId
}
async function evaluate(expression) {
  const value = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.text)
  return value.result.value
}
async function close() {
  if (!child) return
  // Closing this app's sole window invokes normal AI cancellation/worker cleanup.
  if (socket?.readyState === WebSocket.OPEN) await evaluate('window.close()').catch(() => {})
  const result = await Promise.race([exited.then(() => true), delay(15000).then(() => false)])
  socket?.close()
  if (!result) { child.kill(); throw new Error('App did not shut down cleanly') }
  child = undefined
}
try {
  report.stage = 'first launch'
  await launch()
  await until(async () => (await evaluate('window.debateDesktop?.status()'))?.phase === 'login-required')
  assert.equal(await evaluate('document.querySelectorAll(".participant-row").length'), 4)
  assert.equal(await evaluate('typeof window.require'), 'undefined')
  assert.equal(await evaluate('document.querySelector(".session-actions .primary").disabled'), true)
  report.checks.push('Packaged EXE starts React and backend; fresh profile requires login; AI start disabled')
  const record = fixtureRecord(); record.feedback = fixtureFeedback()
  const key = 'skhynix-debate:record:' + record.id
  await evaluate(`localStorage.setItem(${JSON.stringify(key)},${JSON.stringify(JSON.stringify(record))})`)
  report.stage = 'second instance'
  const duplicate = spawn(exe, [`--user-data-dir=${profile}`], { env, windowsHide: true, stdio: 'ignore' })
  const duplicateExit = new Promise(resolve => duplicate.once('exit', resolve))
  assert.notEqual(await Promise.race([duplicateExit, delay(10000).then(() => 'timeout')]), 'timeout')
  report.checks.push('Second instance exits instead of starting a second backend')
  await close()
  report.checks.push('Normal window close exits the app')
  report.stage = 'relaunch'
  await launch()
  await until(async () => (await evaluate('window.debateDesktop?.status()'))?.phase === 'login-required')
  assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(key)}))`), record)
  report.checks.push('Record and feedback restored after full EXE exit and relaunch')
  report.stage = 'backend crash and reconnect'
  const workerIds = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `@(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${child.pid}' | Where-Object { $_.CommandLine -like '*node.mojom.NodeService*' } | ForEach-Object { $_.ProcessId }) | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true }).trim())
  const workerId = Array.isArray(workerIds) ? workerIds[0] : workerIds
  assert.ok(Number.isInteger(workerId))
  process.kill(workerId) // Only this newly launched test app's own Node worker.
  await until(async () => (await evaluate('window.debateDesktop.status()')).phase === 'error')
  assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(key)}))`), record)
  await evaluate('window.debateDesktop.reconnect()')
  await until(async () => (await evaluate('window.debateDesktop.status()')).phase === 'login-required')
  report.checks.push('Worker crash reports error, preserves records and reconnects')
  report.speech = await evaluate('({recognition:!!(window.SpeechRecognition||window.webkitSpeechRecognition),audioDeviceApi:!!navigator.mediaDevices?.getUserMedia,hardwareTested:false})')
  report.success = true
} catch (error) { report.error = error.message; process.exitCode = 1 }
finally {
  await close().catch(error => { report.success = false; report.shutdownError = error.message; process.exitCode = 1 })
  await writeFile('.codex-debate/packaged-ui-check.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
