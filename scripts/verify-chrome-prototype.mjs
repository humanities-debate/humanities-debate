// Own isolated Chrome profile + synthetic Korean audio only. Never reads browser cookies.
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, rm, access } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fixtureRecord, fixtureFeedback } from '../tests/fixtures/feedback.mjs'
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const root = process.cwd(), profile = option('profile') || `verify-${Date.now()}`
if (!/^[a-zA-Z0-9-]{1,40}$/.test(profile)) throw new Error('INVALID_TEST_PROFILE')
const packaged = process.argv.includes('--packaged'), skipSpeech = process.argv.includes('--skip-speech')
const verificationRoot = path.resolve(option('verification-root') || path.join(root, '.codex-debate/chrome-installed-check'))
if (!verificationRoot.startsWith(path.join(root, '.codex-debate') + path.sep)) throw new Error('TEST_ROOT_OUTSIDE_WORKSPACE')
const dataRoot = path.join(packaged ? verificationRoot : path.join(root, '.codex-debate/chrome-prototype'), profile)
const env = { ...process.env }; for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key]
const report = { profile, packaged, executableSource: option('executable') ? 'isolated installer fixture' : packaged ? 'Chrome candidate package' : 'development prototype',
  syntheticAudio: !skipSpeech, realMicrophoneTested: false, differentChatGPTAccounts: 'UNVERIFIED', publicReleaseReady: false, checks: [] }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, timeout = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeout) { try { const result = await check(); if (result) return result } catch { /* startup */ } await delay(200) }
  throw new Error('TIMEOUT: ' + report.stage)
}
let child, socket, session, serial = 0, exited
const pending = new Map()
function command(method, params = {}, target = session) {
  return new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP_TIMEOUT ' + method)) }, 15000)
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(target ? { sessionId: target } : {}) }))
  })
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}
async function launch() {
  await rm(path.join(dataRoot, 'browser/DevToolsActivePort'), { force: true })
  const executable = option('executable') || path.join(root, packaged ? 'release-chrome/win-unpacked/HumanitiesDebateChrome.exe' : 'node_modules/electron/dist/electron.exe')
  const args = [...(packaged ? [`--verification-root=${verificationRoot}`] : [path.join(root, 'desktop/chrome-main.mjs')]), `--profile=${profile}`, '--verify', ...(!skipSpeech ? ['--fake-audio'] : [])]
  child = spawn(executable, args, { env, windowsHide: true, stdio: 'ignore' })
  exited = new Promise(resolve => child.once('exit', resolve))
  const endpoint = await until(async () => {
    const [port, route] = (await readFile(path.join(dataRoot, 'browser/DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/)
    const candidate = new WebSocket(`ws://127.0.0.1:${port}${route}`)
    await new Promise((resolve, reject) => { candidate.addEventListener('open', resolve, { once: true }); candidate.addEventListener('error', reject, { once: true }) })
    return candidate
  })
  socket = endpoint; session = undefined
  socket.addEventListener('message', event => { const message = JSON.parse(event.data), job = pending.get(message.id); if (!job) return; pending.delete(message.id); clearTimeout(job.timer); if (message.error) job.reject(new Error(message.error.message)); else job.resolve(message.result) })
  const page = await until(async () => (await command('Target.getTargets')).targetInfos.find(item => item.type === 'page' && item.url.startsWith('http://127.0.0.1:')))
  session = (await command('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId
  await until(async () => (await evaluate('document.querySelector("#status")?.textContent'))?.includes('로그인이 필요'))
  return page
}
async function close() {
  await command('Browser.close', {}, undefined).catch(() => {})
  assert.notEqual(await Promise.race([exited, delay(15000).then(() => 'timeout')]), 'timeout')
  socket?.close(); child = undefined
}
try {
  report.stage = 'app launch'
  const page = await launch()
  const savedRecord = fixtureRecord(); savedRecord.feedback = fixtureFeedback()
  const recordKey = 'skhynix-debate:record:' + savedRecord.id
  if (process.argv.includes('--expect-existing-marker')) {
    assert.equal(await evaluate('localStorage.getItem("prototype-test-marker")'), 'retained')
    assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(recordKey)}))`), savedRecord)
    report.checks.push('Synthetic transcript and feedback survived previous installer lifecycle step')
  }
  await evaluate(`localStorage.setItem(${JSON.stringify(recordKey)},${JSON.stringify(JSON.stringify(savedRecord))})`)
  report.browser = await command('Browser.getVersion')
  const duplicateExecutable = option('executable') || path.join(root, packaged ? 'release-chrome/win-unpacked/HumanitiesDebateChrome.exe' : 'node_modules/electron/dist/electron.exe')
  const duplicate = spawn(duplicateExecutable, [...(packaged ? [`--verification-root=${verificationRoot}`] : [path.join(root, 'desktop/chrome-main.mjs')]), `--profile=${profile}`, '--verify'], { env, windowsHide: true, stdio: 'ignore' })
  const duplicateExit = new Promise(resolve => duplicate.once('exit', resolve))
  assert.notEqual(await Promise.race([duplicateExit, delay(10000).then(() => 'timeout')]), 'timeout')
  report.checks.push('Duplicate launch for same profile exits without replacing the active server')
  report.checks.push('Clean profile requires its own login; no developer credentials inherited')
  await evaluate('document.querySelector("#open").click()')
  await until(async () => await evaluate('document.querySelector("iframe").contentDocument.querySelectorAll(".participant-row").length === 4'))
  report.checks.push('Existing React UI: four participant rows; no desktop Whisper bridge')
  assert.equal(await evaluate('typeof document.querySelector("iframe").contentWindow.debateDesktop'), 'undefined')
  if (!skipSpeech) {
  report.stage = 'speech'
  // Exercise real browser API, not a SpeechRecognition mock. Save counts/errors, never transcripts.
  await evaluate(`window.speechProbe={standard:!!window.SpeechRecognition,prefixed:!!window.webkitSpeechRecognition,events:[],interim:0,final:0};
    window.startSpeechProbe=async()=>{const p=window.speechProbe;try{const s=await navigator.mediaDevices.getUserMedia({audio:true});p.capture=s.getAudioTracks()[0].readyState;s.getTracks().forEach(t=>t.stop());}catch(e){p.capture=e.name;}
    const C=window.SpeechRecognition||window.webkitSpeechRecognition;if(!C)return;const r=window.probeRecognizer=new C();r.lang='ko-KR';r.continuous=true;r.interimResults=true;
    for(const k of ['start','audiostart','soundstart','speechstart','speechend','audioend','end'])r['on'+k]=()=>p.events.push(k);
    r.onerror=e=>{p.error=e.error};r.onresult=e=>{for(let i=e.resultIndex;i<e.results.length;i++){if(e.results[i].isFinal)p.final++;else p.interim++;}};r.start();};void window.startSpeechProbe();`)
  await delay(12000)
  report.appSpeech = await evaluate('window.speechProbe')
  await evaluate('window.probeRecognizer?.abort()')
  report.stage = 'normal Chrome window comparison'
  const target = await command('Target.createTarget', { url: new URL(page.url).origin, newWindow: true })
  session = (await command('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId
  await until(async () => await evaluate('!!document.querySelector("#status")'))
  await evaluate(`window.speechProbe={standard:!!window.SpeechRecognition,prefixed:!!window.webkitSpeechRecognition,events:[],interim:0,final:0};const C=window.SpeechRecognition||window.webkitSpeechRecognition;const r=window.probeRecognizer=new C();r.lang='ko-KR';r.continuous=true;r.interimResults=true;for(const k of ['start','audiostart','end'])r['on'+k]=()=>window.speechProbe.events.push(k);r.onerror=e=>window.speechProbe.error=e.error;r.onresult=e=>{for(let i=e.resultIndex;i<e.results.length;i++){if(e.results[i].isFinal)window.speechProbe.final++;else window.speechProbe.interim++;}};r.start()`)
  await delay(12000)
  report.normalSpeech = await evaluate('window.speechProbe')
  await evaluate('window.probeRecognizer?.abort()')
  }
  await evaluate('localStorage.setItem("prototype-test-marker","retained")')
  const { port } = JSON.parse(await readFile(path.join(dataRoot, 'port.json'), 'utf8'))
  report.stage = 'shutdown'
  await close()
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`))
  report.checks.push('Closing owned Chrome exits launcher/backend; local port closed')
  report.stage = 'restart'
  await launch()
  assert.equal(await evaluate('localStorage.getItem("prototype-test-marker")'), 'retained')
  assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(recordKey)}))`), savedRecord)
  report.checks.push('Same profile/origin restores local browser data after restart')
  // Only synthetic files in this script's new profile. Never edit real A/B credentials.
  const fixture = JSON.stringify({ fixture: true, auth_mode: 'invalid-test-fixture' })
  const authDirectory = path.join(dataRoot, 'codex-auth')
  const neighbor = path.join(dataRoot, 'neighbor-fixture', 'auth.json')
  await mkdir(path.dirname(neighbor), { recursive: true })
  await writeFile(neighbor, fixture)
  await writeFile(path.join(authDirectory, 'auth.json'), fixture)
  await writeFile(path.join(authDirectory, 'auth.json.next'), fixture)
  await evaluate('fetch("/launcher/logout",{method:"POST",headers:{"X-Launch-Client":"local-ui"}})')
  await until(async () => {
    try { await access(path.join(authDirectory, 'auth.json')); return false } catch { return true }
  })
  await assert.rejects(access(path.join(authDirectory, 'auth.json.next')))
  assert.equal(await readFile(neighbor, 'utf8'), fixture)
  assert.equal(await evaluate('localStorage.getItem("prototype-test-marker")'), 'retained')
  await until(async () => (await evaluate('document.querySelector("#status")?.textContent'))?.includes('로그인이 필요'))
  report.checks.push('Logout clears only synthetic auth.json/auth.json.next; unrelated fixture and browser data preserved; no remote revocation tested')
  await close(); report.success = true
} catch (error) { report.error = error.message; process.exitCode = 1 }
finally {
  if (child) { try { await close() } catch { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } }
  await mkdir(path.join(root, '.codex-debate/chrome-prototype'), { recursive: true })
  await writeFile(path.join(root, '.codex-debate/chrome-prototype/verification.json'), JSON.stringify(report, null, 2))
  if (packaged) await writeFile(path.join(root, '.codex-debate', option('executable') ? 'chrome-installer-fixture-verification.json' : 'chrome-installed-verification.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
