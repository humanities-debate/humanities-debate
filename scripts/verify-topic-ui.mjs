// Real React/DOM integration checks with synthetic records and Mock AI only.
// Default: development Electron. --packaged: packaged EXE. --chrome: headless Chrome.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import electron from 'electron'
import { fixtureRecord, fixtureFeedback } from '../tests/fixtures/feedback.mjs'

const chrome = process.argv.includes('--chrome'), packaged = process.argv.includes('--packaged')
const mode = chrome ? 'chrome' : packaged ? 'packaged' : 'electron'
await mkdir('.codex-debate', { recursive: true })
const profile = await mkdtemp(path.resolve('.codex-debate/topic-ui-'))
const report = { mode, success: false, checks: [] }
const env = { ...process.env }
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key]
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check) {
  for (let attempt = 0; attempt < 300; attempt++) { if (await check()) return; await delay(100) }
  throw new Error('UI timeout: ' + report.stage)
}
let server, child, exited, socket, session, counter = 0
const pending = new Map()
function command(method, params = {}, target = session) {
  return new Promise((resolve, reject) => {
    const id = ++counter, timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timeout')) }, 15000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params, ...(target ? { sessionId: target } : {}) }))
  })
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}
async function click(text) {
  await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled);if(!b)throw new Error('Missing button');b.click()})()`)
  await delay(100)
}
const open = () => evaluate('document.querySelector(".topic-banner details")?.open ?? null')
async function toggle() { await evaluate('document.querySelector(".topic-banner summary").click()'); await delay(100) }
async function screenshot(name) {
  const result = await command('Page.captureScreenshot', { format: 'png' })
  await writeFile(`.codex-debate/topic-ui-${mode}-${name}.png`, Buffer.from(result.data, 'base64'))
}
async function size(width, height) {
  await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await delay(100)
}
try {
  let url = 'debate://app/'
  if (chrome) {
    const dist = path.resolve('dist')
    server = createServer(async (req, res) => {
      // Local static fixture server; never forwards to a real AI endpoint.
      const pathname = new URL(req.url, 'http://localhost').pathname
      const file = path.resolve(dist, '.' + (pathname === '/' ? '/index.html' : pathname))
      if (!file.startsWith(dist + path.sep)) { res.writeHead(403); res.end(); return }
      try {
        const content = await readFile(file)
        res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[path.extname(file)] ?? 'application/octet-stream')
        res.end(content)
      } catch { res.writeHead(404); res.end() }
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${server.address().port}/`
  }
  const exe = chrome ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : packaged ? path.resolve('release/win-unpacked/HumanitiesDebate.exe') : electron
  const args = [...(!chrome && !packaged ? ['.'] : []), `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', ...(chrome ? ['--headless=new', '--no-first-run', '--no-default-browser-check', url] : [])]
  child = spawn(exe, args, { env, windowsHide: true, stdio: 'ignore' })
  exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve) })
  let endpoint
  report.stage = 'launch'
  await until(async () => { try { const [port, route] = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/); endpoint = `ws://127.0.0.1:${port}${route}`; return true } catch { return false } })
  socket = new WebSocket(endpoint)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data), task = pending.get(data.id)
    if (!task) return
    clearTimeout(task.timer); pending.delete(data.id)
    if (data.error) task.reject(new Error(data.error.message)); else task.resolve(data.result)
  })
  let target
  await until(async () => { target = (await command('Target.getTargets')).targetInfos.find(t => t.type === 'page' && t.url === url); return Boolean(target) })
  session = (await command('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId
  await until(async () => (await evaluate('document.querySelectorAll(".participant-row").length')) === 4)
  await size(1280, 900)
  const record = fixtureRecord(); record.feedback = fixtureFeedback()
  await evaluate(`localStorage.setItem(${JSON.stringify('skhynix-debate:record:' + record.id)},${JSON.stringify(JSON.stringify(record))})`)
  await evaluate(`(()=>{const s=[...document.querySelectorAll('select')].find(s=>[...s.options].some(o=>o.value==='mock'));Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'mock');s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await click('주제 다시 뽑기')
  // One prepared topic intentionally has no explanation. Pick context for this test.
  for (let i = 0; i < 30 && !(await evaluate('Boolean(document.querySelector(".topic-copy .topic-explanation"))')); i++) await click('주제 다시 뽑기')
  assert.equal(await evaluate('Boolean(document.querySelector(".topic-copy .topic-explanation"))'), true)
  await screenshot('settings')
  await click('시작')
  report.stage = 'start expands context'
  await until(open)
  assert.equal(await evaluate('document.querySelectorAll(".participant-row").length'), 4)
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".topic-banner")).position'), 'sticky')
  await toggle(); assert.equal(await open(), false)
  await click('일시정지'); assert.equal(await open(), false)
  await click('재개'); assert.equal(await open(), false)
  report.stage = 'AI turn preserves collapsed state'
  await until(async () => await evaluate('Boolean(document.querySelector(".participant-row .message-text"))'))
  assert.equal(await open(), false)
  const typography = await evaluate(`(()=>{const e=document.querySelector('.message-text'),s=getComputedStyle(e);return {fontSize:s.fontSize,lineHeight:s.lineHeight,rows:document.querySelectorAll('.participant-row').length,minHeight:getComputedStyle(document.querySelector('.participant-row')).minHeight}})()`)
  assert.deepEqual(typography, { fontSize: '15px', lineHeight: '27.75px', rows: 4, minHeight: '96px' })
  report.typography = typography
  await toggle(); assert.equal(await open(), true)
  await screenshot('discussion')
  await evaluate('window.scrollTo(0,400)')
  assert.equal(await evaluate('Math.round(document.querySelector(".topic-banner").getBoundingClientRect().top)'), 0)
  await evaluate('window.scrollTo(0,0)')
  await size(390, 844)
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".message-text")).fontSize'), '14px')
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true)
  assert.ok(await evaluate('document.querySelector(".topic-banner").getBoundingClientRect().height<innerHeight/2'))
  await screenshot('narrow')
  await size(1280, 900)
  report.checks.push('Auto-open; manual toggle; paused/resumed and AI turn preserve choice; sticky topic; 4 rows; unchanged font/line-height/card minimum; narrow viewport')
  await toggle(); assert.equal(await open(), false)
  await click('토론 종료'); await screenshot('result')
  await click('같은 주제로 다시 연습'); await click('다시 시작')
  await until(open)
  report.checks.push('New session with same topic resets to expanded')
  await click('토론 종료'); await click('새 토론 시작')
  await evaluate(`[...document.querySelectorAll('.topic-modes label')].find(e=>e.textContent.includes('직접 입력')).click()`)
  await evaluate(`(()=>{const t=document.querySelector('.topic-field textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'쉬는 시간을 늘리면 일을 더 잘할 수 있을까?');t.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await click('다시 시작'); assert.equal(await open(), null)
  assert.equal(await evaluate('document.querySelectorAll(".topic-banner .topic-explanation").length'), 0)
  report.checks.push('Custom topic has no empty context area')
  await click('토론 종료'); await click('과거 토론 보기')
  await click('다시 불러오기'); await screenshot('library')
  await evaluate(`(()=>{const row=[...document.querySelectorAll('.records-list > li')].find(e=>e.textContent.includes(${JSON.stringify(record.topic.title)}));[...row.querySelectorAll('button')].find(b=>b.textContent==='기록 열기').click()})()`)
  await until(async () => await evaluate('Boolean(document.querySelector(".feedback-total"))'))
  await evaluate('document.querySelector(".feedback-total").scrollIntoView()')
  await screenshot('feedback')
  assert.equal(await evaluate('document.querySelectorAll(".feedback-category").length'), 5)
  report.checks.push('Saved record/100-point feedback renders without AI generation')
  report.success = true
} catch (error) { report.error = error.message; process.exitCode = 1 }
finally {
  if (socket?.readyState === WebSocket.OPEN) {
    if (chrome) await command('Browser.close', {}, undefined).catch(() => {})
    else await evaluate('window.close()').catch(() => {})
  }
  if (child) {
    let timer
    const clean = await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 15000) })])
    clearTimeout(timer)
    if (!clean) { child.kill(); report.shutdownError = true; process.exitCode = 1 }
  }
  socket?.close()
  if (server) await new Promise(resolve => server.close(resolve))
  await writeFile(`.codex-debate/topic-ui-${mode}.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
