// Packaged EXE (or --development), isolated profile and synthetic audio device. No login/AI/human recording.
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import electron from 'electron'
const root = process.cwd()
await mkdir('.codex-debate', { recursive: true })
const profile = await mkdtemp(path.join(root, '.codex-debate', 'packaged-speech-'))
const development = process.argv.includes('--development')
const exe = development ? electron : path.join(root, 'release', 'win-unpacked', 'HumanitiesDebate.exe')
const env = { ...process.env }
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key]
const report = { success: false, checks: [], profile, synthetic: true, humanMicrophoneTested: false }
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
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, 180000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params, ...(targetSession ? { sessionId: targetSession } : {}) }))
  })
}
async function launch() {
  await rm(path.join(profile, 'DevToolsActivePort'), { force: true })
  child = spawn(exe, [...(development ? ['.'] : []), `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + path.resolve('.codex-debate/korean-long.wav') + '%noloop'], { env, windowsHide: true, stdio: 'ignore' })
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
async function click(text) {return evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled);if(!b)throw new Error('Button unavailable');b.click()})()`)}
try {
 report.stage='launch'; await launch()
 await until(async()=>await evaluate('Boolean(document.querySelector(".participant-row"))'))
 await evaluate(`(()=>{const s=[...document.querySelectorAll('select')].find(s=>[...s.options].some(o=>o.value==='mock'));Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'mock');s.dispatchEvent(new Event('change',{bubbles:true}));window.SpeechRecognition=window.webkitSpeechRecognition=class{start(){throw new Error('Must use local engine')}}})()`)
 await until(async()=>!(await evaluate('document.querySelector(".session-actions .primary").disabled')))
 await evaluate(`(()=>{const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);window.captureCount=0;navigator.mediaDevices.getUserMedia=async(...args)=>{window.captureCount++;const stream=await original(...args);window.testTrack=stream.getAudioTracks()[0];return stream}})()`)
 await click('시작'); await click('말하기 (마이크)')
 report.stage='capture Korean synthetic audio'
 await until(async()=>await evaluate('document.body.textContent.includes("듣고 있습니다.")'))
 await command('Network.enable'); await command('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0})
 const recordingStart=Date.now(), captionTimes=[]
 let previousCaption=''
 while(Date.now()-recordingStart<27000){
   const caption=await evaluate('document.querySelector("#participant-user .speech-interim")?.textContent ?? ""')
   if(caption && caption!==previousCaption){captionTimes.push(Date.now()-recordingStart);previousCaption=caption}
   await delay(500)
 }
 report.captionUpdateTimesMs=captionTimes
 assert.ok(captionTimes.length>=2,'Captions must update before stop')
 assert.equal(await evaluate('window.captureCount'),1)
 assert.equal(await evaluate('window.testTrack.readyState'),'live')
 report.checks.push('Multiple provisional captions during one continuous live recording; no extra microphone starts')
 assert.equal(await evaluate('Boolean(document.querySelector("#user-input"))'),false)
 await evaluate('document.querySelector(".user-input-panel button[type=submit]").click()')
 report.stage='local transcription'
 await until(async()=>await evaluate('Boolean(document.querySelector("#user-input"))'),180000)
 const recognized=await evaluate('({characters:document.querySelector("#user-input").value.length,finalClause:document.querySelector("#user-input").value.replaceAll(" ","").includes("필요하다고")})')
 assert.ok(recognized.characters>50);assert.equal(recognized.finalClause,true)
 assert.equal(await evaluate('Boolean(document.querySelector("#participant-user .speech-interim"))'),false)
 assert.equal(await evaluate('window.testTrack.readyState'),'ended')
 report.recognized=recognized
 assert.equal(await evaluate('document.querySelectorAll(".history-session li").length'),0)
 report.checks.push('Offline synthetic microphone -> AudioWorklet -> IPC -> bundled CPU Whisper -> Korean review; browser speech API unused')
 await evaluate(`(()=>{const t=document.querySelector('#user-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,t.value+' 확인했습니다.');t.dispatchEvent(new Event('input',{bubbles:true}))})()`)
 await click('발언 완료')
 await until(async()=>await evaluate('!document.querySelector(".user-input-panel")'))
 report.checks.push('Explicit review/edit/submit; AI waits through transcription')
 // Interrupt the new pending AI immediately, then cancel the second recognition during conversion.
 await click('말하기 (마이크)')
 await until(async()=>await evaluate('document.body.textContent.includes("듣고 있습니다.")'))
 await delay(5000); await evaluate('document.querySelector(".user-input-panel button[type=submit]").click()')
 await click('토론 종료')
 report.stage='end cancels processing'
 await delay(3000)
 assert.equal(await evaluate('Boolean(document.querySelector(".user-input-panel"))'),false)
 const records=await evaluate('Object.keys(localStorage).filter(k=>k.startsWith("skhynix-debate:record:")).map(k=>JSON.parse(localStorage.getItem(k)))')
 const record=records[0]
 assert.ok(record)
 const utterances=record.messages ?? record.history ?? record.utterances
 assert.ok(utterances && utterances.filter(m=>m.speakerId==="user").length===1)
 assert.ok(utterances.find(m=>m.speakerId==='user').text.endsWith('확인했습니다.'))
 report.checks.push('AI interruption; rapid microphone reuse; debate end cancels local processing; exactly one confirmed user record')
 report.synthetic=true;report.humanMicrophoneTested=false;report.development=development;report.success=true
} catch(error){report.error=error.message;process.exitCode=1}
finally {
 await close().catch(error=>{report.shutdownError=error.message;process.exitCode=1})
 await writeFile('.codex-debate/speech-e2e-'+(development?'development':'packaged')+'.json',JSON.stringify(report,null,2))
 console.log(JSON.stringify(report))
}
