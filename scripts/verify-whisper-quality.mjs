// Local, synthetic fixtures only. No microphone recording, cloud requests or AI calls.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import assert from 'node:assert/strict'
import { wavFromPCM } from '../desktop/whisper.mjs'
import { QUALITY_ARGS } from '../desktop/whisperOptions.mjs'
const root = path.resolve('.codex-debate/whisper-quality')
await mkdir(root, { recursive: true })
const packaged = process.argv.includes('--packaged')
const assets = path.resolve(packaged ? 'release/win-unpacked/resources/whisper' : 'desktop-assets/whisper')
async function fixture(name) {
  const wav = await readFile('.codex-debate/korean-' + name + '.wav')
  for (let i = 12; i + 8 <= wav.length;) {
    const n = wav.readUInt32LE(i + 4)
    if (wav.toString('ascii', i, i + 4) === 'data') return wav.subarray(i + 8, i + 8 + n)
    i += 8 + n + n % 2
  }
  throw new Error('Missing synthetic PCM')
}
const sentences = ['저는 현재 어려움을 겪는 사람들을 먼저 지원해야 한다고 생각합니다.', '그런데 미래 세대를 위해서도 일정한 예산은 남겨야 하지 않을까요?', '상대방 의견도 이해하지만 저는 다른 해결 방법이 필요하다고 봅니다.']
const one = await fixture('1'), long = await fixture('long'), repeated = await fixture('repeat')
const silent = seconds => Buffer.alloc(seconds * 32000)
// Deterministic synthetic fan-like hum / broadband noise, not a recording of a real room.
const noise = silent(20)
let seed = 12345
for (let i = 0; i < noise.length / 2; i++) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  noise.writeInt16LE(Math.round((seed / 4294967296 - 0.5) * 600 + Math.sin(i * 2 * Math.PI * 60 / 16000) * 300), i * 2)
}
const cases = [
  ['silence-10', silent(10), ''], ['silence-20', silent(20), ''], ['noise-20', noise, ''],
  ['short', one, sentences[0]], ['long-pause', long, sentences.join(' ')],
  ['tail-silence', Buffer.concat([one, silent(6)]), sentences[0]],
  ['repeat', repeated, '하지만 제 경험상 하지만 제 경험상 하지만 제 경험상 이 방법은 도움이 됩니다.'],
  ['end-word', await fixture('end-word'), '이것으로 제 발언은 끝입니다. 끝까지 들어주셔서 감사합니다.'],
]
function cer(actual, reference) {
  const clean = t => t.replace(/[^가-힣a-z0-9]/gi, '')
  const a = clean(actual), b = clean(reference), row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) { let diag = row[0]; row[0] = i
    for (let j = 1; j <= b.length; j++) { const old = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diag + Number(a[i - 1] !== b[j - 1])); diag = old }
  }
  return b.length ? row[b.length] / b.length : null
}
const results = []
for (const [name, pcm, reference] of cases) for (const quality of (packaged ? [true] : [false, true])) {
  const audio = path.join(root, 'input.wav'), out = path.join(root, 'result')
  await writeFile(audio, wavFromPCM(pcm))
  const args = ['-m', 'ggml-base.bin', '-f', audio, '-l', 'ko', '-t', '4', '-ng', '-nt', '-np', '-otxt', '-of', out, ...(quality ? QUALITY_ARGS : [])]
  const start = performance.now()
  const code = await new Promise(resolve => {
    const child = spawn(path.join(assets, 'whisper-cli.exe'), args, { cwd: assets, windowsHide: true, shell: false, stdio: 'ignore' })
    const timeout = setTimeout(() => child.kill(), 120000)
    child.once('error', () => { clearTimeout(timeout); resolve(-1) })
    child.once('close', code => { clearTimeout(timeout); resolve(code) })
  })
  const text = code === 0 ? (await readFile(out + '.txt', 'utf8')).trim() : ''
  const result = { name, quality, code, seconds: pcm.length / 32000, elapsedMs: Math.round(performance.now() - start), characters: text.length,
    cer: cer(text, reference), repetitionCount: name === 'repeat' ? (text.match(/경험상/g) ?? []).length : null,
    endWords: name === 'end-word' ? (text.match(/끝/g) ?? []).length : null, unwantedMarker: /[[(](끝|놀람|몇 번째)[\])]/.test(text), text }
  results.push(result)
  const { text: _text, ...metrics } = result; void _text; console.log(JSON.stringify(metrics))
  await rm(audio); await rm(out + '.txt', { force: true })
}
const qualityFailures = results.filter(r => r.quality && (
  r.code !== 0 || r.unwantedMarker ||
  ((r.name.startsWith('silence') || r.name.startsWith('noise')) ? r.characters !== 0 : !r.characters) ||
  (r.name === 'repeat' && r.repetitionCount !== 3) || (r.name === 'end-word' && r.endWords !== 2) ||
  (r.cer !== null && r.cer > 0.2)
)).map(r => r.name)
await writeFile(path.join(root, packaged ? 'packaged.json' : 'comparison.json'), JSON.stringify({ synthetic: true, humanMicrophoneTested: false, qualityFailures, results }, null, 2))
console.log(JSON.stringify({ qualityFailures, humanMicrophoneTested: false }))
if (qualityFailures.length) process.exitCode = 1
for (const r of results.filter(r => r.quality)) {
  assert.equal(r.code, 0)
  if (r.name.startsWith('silence') || r.name.startsWith('noise')) assert.equal(r.characters, 0, r.name)
  else { assert.ok(r.characters > 0, r.name); assert.equal(r.unwantedMarker, false, r.name) }
}
