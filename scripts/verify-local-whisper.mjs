// Uses synthetic Korean WAVs generated locally, never records a microphone or calls AI.
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { createWhisperService } from '../desktop/whisper.mjs'
export function readPCM(wav) {
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  let format
  for (let offset = 12; offset + 8 <= wav.length;) {
    const kind = wav.toString('ascii', offset, offset + 4), size = wav.readUInt32LE(offset + 4)
    if (kind === 'fmt ') format = { code: wav.readUInt16LE(offset + 8), channels: wav.readUInt16LE(offset + 10), rate: wav.readUInt32LE(offset + 12), bits: wav.readUInt16LE(offset + 22) }
    if (kind === 'data') {
      assert.deepEqual(format, { code: 1, channels: 1, rate: 16000, bits: 16 })
      return new Uint8Array(wav.subarray(offset + 8, offset + 8 + size))
    }
    offset += 8 + size + (size % 2)
  }
  throw new Error('No PCM data')
}
const packaged = process.argv.includes('--packaged')
const assets = path.resolve(packaged ? 'release/win-unpacked/resources/whisper' : 'desktop-assets/whisper')
const dataRoot = path.resolve('.codex-debate/whisper-native-test')
await mkdir(dataRoot, { recursive: true })
const service = createWhisperService({ assets, dataRoot })
const report = { packaged, synthetic: true, humanMicrophoneTested: false, tests: [] }
const expected = ['저는 현재 어려움을 겪는 사람들을 먼저 지원해야 한다고 생각합니다.', '그런데 미래 세대를 위해서도 일정한 예산은 남겨야 하지 않을까요?', '상대방 의견도 이해하지만 저는 다른 해결 방법이 필요하다고 봅니다.']
function errorRate(actual, reference) {
  const clean = text => text.replace(/[^가-힣a-z0-9]/gi, '')
  const a = clean(actual), b = clean(reference), row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]; row[0] = i
    for (let j = 1; j <= b.length; j++) { const previous = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)); diagonal = previous }
  }
  return row[b.length] / b.length
}
try {
  for (const [name, terms] of [['1', ['어려움', '지원']], ['2', ['미래', '예산']], ['3', ['의견', '해결']], ['long', ['지원', '예산', '해결']]]) {
    const pcm = readPCM(await readFile('.codex-debate/korean-' + name + '.wav'))
    const started = Date.now(), result = await service.transcribe('test-' + name, pcm)
    const matched = result.ok && terms.every(term => result.text.replaceAll(' ', '').includes(term))
    const rate = result.ok ? errorRate(result.text, name === 'long' ? expected.join(' ') : expected[Number(name) - 1]) : 1
    report.tests.push({ name, durationSeconds: pcm.length / 32000, elapsedMs: Date.now() - started, ok: result.ok, keyTermsMatched: Boolean(matched), characterErrorRate: rate, ...(result.ok ? { characters: result.text.length, finalClausePresent: result.text.replaceAll(' ', '').includes(name === '1' ? '생각합니다' : name === '2' ? '않을까요' : '필요하다고') } : { code: result.code }) })
    assert.ok(result.ok && result.text.trim() && rate < 0.2, 'Korean transcription accuracy below test threshold: ' + name)
  }
  const first = readPCM(await readFile('.codex-debate/korean-1.wav')).subarray(0, 160000)
  const short = await service.transcribe('five-seconds', first)
  assert.ok(short.ok && short.text.trim()); report.tests.push({ name: 'five-seconds', durationSeconds: first.length / 32000, ok: true })
  assert.deepEqual(await service.transcribe('silence', new Uint8Array(160000)), { ok: true, text: '' })
  assert.deepEqual(await readdir(path.join(dataRoot, 'speech-temp')), [])
  const phrase = readPCM(await readFile('.codex-debate/korean-1.wav'))
  const repeated = await service.transcribe('repeated-phrase', Buffer.concat([phrase, Buffer.alloc(32000), phrase]))
  const occurrences = repeated.ok ? (repeated.text.match(/지원/g) ?? []).length : 0
  report.tests.push({ name: 'repeated-phrase', ok: repeated.ok, occurrences, characters: repeated.ok ? repeated.text.length : 0,
    characterErrorRate: repeated.ok ? errorRate(repeated.text, expected[0] + ' ' + expected[0]) : 1 })
  assert.equal(occurrences, 2, 'Both spoken repetitions must remain in full transcription')
  report.success = true
} catch (error) { report.success = false; report.error = error.message; process.exitCode = 1 }
finally {
  await service.close()
  await writeFile('.codex-debate/whisper-native-' + (packaged ? 'packaged' : 'development') + '.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
