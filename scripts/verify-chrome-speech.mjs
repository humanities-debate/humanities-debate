// Real installed Chrome, isolated disposable profile, synthetic silence only.
// No credentials, account profiles, human microphone, AI calls or speech contents are read.
import assert from 'node:assert/strict'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createChromeServer } from '../desktop/chrome-server.mjs'
import { build } from 'esbuild'

const root = process.cwd(), testRoot = path.join(root, '.codex-debate', `chrome-speech-${Date.now()}`)
await mkdir(testRoot, { recursive: true })
const wav = Buffer.alloc(44 + 16000 * 2 * 20)
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40)
const audio = path.join(testRoot, 'silence.wav')
await writeFile(audio, wav)
let binary
for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean)) {
  const candidate = path.join(base, 'Google/Chrome/Application/chrome.exe')
  try { await access(candidate); binary = candidate; break } catch { /* next standard location */ }
}
assert.ok(binary, 'GOOGLE_CHROME_NOT_INSTALLED')
const gateways = []
async function gateway(portal) {
  const instance = createChromeServer({ dist: path.join(root, 'dist'), portal: path.join(root, portal), secret: 'synthetic-test-only',
    getBackend: () => undefined, getStatus: () => ({ phase: 'ready', profile: 'synthetic', accounts: [] }), action: async () => ({ ok: true }) })
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve))
  gateways.push(instance)
  return { ...instance, origin: `http://127.0.0.1:${instance.server.address().port}` }
}
const old = await gateway('desktop/chrome'), current = await gateway('desktop/chrome-siwc')
const browserProfile = path.join(testRoot, 'browser')
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => new Set(['systemroot', 'windir', 'path', 'pathext', 'userprofile', 'appdata', 'localappdata', 'temp', 'tmp']).has(key.toLowerCase())))
const child = spawn(binary, [`--user-data-dir=${browserProfile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-mode',
  `--app=${current.origin}/#${current.capability}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
  '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${audio}%noloop`], { env, windowsHide: true, stdio: 'ignore' })
const exited = new Promise(resolve => child.once('exit', resolve))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, timeout = 20000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { try { const value = await check(); if (value) return value } catch { /* startup only */ } await delay(150) }
  throw new Error('BROWSER_PROBE_TIMEOUT')
}
let socket, session, serial = 0
const pending = new Map()
function command(method, params = {}, target = session) {
  return new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP_TIMEOUT')) }, 15000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params, ...(target ? { sessionId: target } : {}) }))
  })
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
  assert.ok(!result.exceptionDetails, 'PROBE_SCRIPT_ERROR')
  return result.result.value
}
const report = { syntheticSilence: true, realMicrophone: 'UNVERIFIED', actualKoreanRecognition: 'UNVERIFIED', noAIRequests: true, cases: {} }
try {
  const endpoint = await until(async () => {
    const [port, route] = (await readFile(path.join(browserProfile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/)
    return `ws://127.0.0.1:${port}${route}`
  })
  socket = new WebSocket(endpoint)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), job = pending.get(message.id)
    if (!job) return
    pending.delete(message.id); clearTimeout(job.timer)
    if (message.error) job.reject(new Error('CDP_ERROR')); else job.resolve(message.result)
  })
  const version = await command('Browser.getVersion', {}, undefined)
  report.browser = { product: version.product, userAgent: version.userAgent }
  const target = await until(async () => (await command('Target.getTargets', {}, undefined)).targetInfos.find(item => item.type === 'page' && item.url.startsWith(current.origin)))
  session = (await command('Target.attachToTarget', { targetId: target.targetId, flatten: true }, undefined)).sessionId
  // Loopback cookies are host-scoped, not port-scoped. After claiming the old gateway,
  // use its origin for the normal-window comparison in this same disposable profile.
  for (const [label, server, framed] of [['officialAppIframe', current, true], ['prototypeAppIframe', old, true], ['normalChromePage', old, false]]) {
    await command('Browser.grantPermissions', { origin: server.origin, permissions: ['audioCapture'] }, undefined)
    if (label !== 'officialAppIframe') {
      if (!framed) {
        const page = await command('Target.createTarget', { url: `${server.origin}/app`, newWindow: true }, undefined)
        session = (await command('Target.attachToTarget', { targetId: page.targetId, flatten: true }, undefined)).sessionId
      } else await command('Page.navigate', { url: `${server.origin}/#${server.capability}` })
    }
    if (label === 'prototypeAppIframe') {
      await until(() => evaluate('Boolean(document.querySelector("#open") && !document.querySelector("#open").disabled)'))
      await evaluate('document.querySelector("#open").click()')
    }
    await until(() => evaluate(framed ? 'Boolean(document.querySelector("iframe")?.contentDocument?.querySelector(".participant-row"))' : 'Boolean(document.querySelector(".participant-row"))'))
    const context = framed ? 'document.querySelector("iframe").contentWindow' : 'window'
    await evaluate(`(async()=>{const w=${context};const C=w.SpeechRecognition||w.webkitSpeechRecognition;
      const p=w.speechProbe={standard:!!w.SpeechRecognition,prefixed:!!w.webkitSpeechRecognition,secureContext:w.isSecureContext,
      desktopWhisper:!!w.debateDesktop,microphonePolicy:w.document.featurePolicy?.allowsFeature('microphone')??null,events:[]};
      p.permission=(await w.navigator.permissions.query({name:'microphone'})).state;
      try{const stream=await w.navigator.mediaDevices.getUserMedia({audio:true});p.syntheticCapture=stream.getAudioTracks()[0]?.readyState;stream.getTracks().forEach(t=>t.stop())}catch(e){p.syntheticCapture=e.name}
      if(!C)return;const r=w.probeRecognition=new C();r.lang='ko-KR';r.continuous=true;r.interimResults=true;
      const started=w.performance.now();for(const event of ['start','audiostart','soundstart','speechstart','audioend','end'])r['on'+event]=()=>p.events.push({event,elapsedMs:Math.round(w.performance.now()-started)});
      r.onerror=e=>p.events.push({event:'error',code:['no-speech','network','not-allowed','service-not-allowed','audio-capture','aborted'].includes(e.error)?e.error:'other',elapsedMs:Math.round(w.performance.now()-started)});
      r.onresult=()=>p.events.push({event:'result',elapsedMs:Math.round(w.performance.now()-started)});try{r.start()}catch(e){p.startError=e.name}})()`)
    await delay(9000)
    await evaluate(`${context}.probeRecognition?.abort()`)
    await delay(200)
    report.cases[label] = await evaluate(`${context}.speechProbe`)
  }
  if (process.argv.includes('--restart-regression')) {
    const previous = execFileSync('git', ['show', 'f41c0cf:src/speech/session.ts'], { encoding: 'utf8', windowsHide: true })
    report.restartRegression = {}
    for (const [label, contents] of [['before', previous], ['after', await readFile('src/speech/session.ts', 'utf8')]]) {
      const bundle = await build({ stdin: { contents, loader: 'ts', resolveDir: path.join(root, 'src/speech') }, bundle: true, write: false, format: 'iife', globalName: 'ProbeSpeech' })
      await evaluate(`(()=>{${bundle.outputFiles[0].text};window.restartProbe={attempts:0,submitted:0,phases:[]};
        window.controllerProbe=ProbeSpeech.createSpeechSession(()=>{window.restartProbe.attempts++;return new (window.SpeechRecognition||window.webkitSpeechRecognition)()},
        s=>{const phases=window.restartProbe.phases;if(phases.at(-1)!==s.phase)phases.push(s.phase)},()=>window.restartProbe.submitted++);
        window.controllerProbe.start()})()`)
      await delay(31000)
      report.restartRegression[label] = await evaluate('(()=>{const s=window.controllerProbe.getSnapshot();return {...window.restartProbe,phase:s.phase,errorCode:s.errorCode??null,diagnostics:s.diagnostics??[]}})()')
      await evaluate('window.controllerProbe.dispose()')
    }
    assert.equal(report.restartRegression.before.phase, 'error')
    assert.equal(report.restartRegression.before.attempts, 3)
    assert.notEqual(report.restartRegression.after.phase, 'error')
    assert.ok(report.restartRegression.after.attempts >= 4)
    assert.equal(report.restartRegression.after.submitted, 0)
  }
  report.completed = true
} finally {
  if (socket?.readyState === WebSocket.OPEN) await command('Browser.close', {}, undefined).catch(() => {})
  socket?.close()
  if (await Promise.race([exited.then(() => false), delay(10000).then(() => true)])) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  for (const item of gateways) { item.server.closeAllConnections(); await new Promise(resolve => item.server.close(resolve)) }
  await writeFile(path.join(root, '.codex-debate/chrome-speech-comparison.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
