import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createLocalSpeechSession, previewDelay } from '../src/speech/localSession.ts'
import { previewWindow } from '../src/speech/previewWindow.ts'
import { VAD_MODEL, VAD_BYTES, QUALITY_ARGS } from '../desktop/whisperOptions.mjs'
import { endMarkerEdit } from '../src/speech/endMarker.ts'
import { createWhisperService, wavFromPCM, MAX_AUDIO_BYTES } from '../desktop/whisper.mjs'

const flush = () => new Promise(resolve => setImmediate(resolve))
const sessions = []
afterEach(() => { for (const session of sessions.splice(0)) session.dispose() })
test('caption boundaries: preserve continuous speech, split only quiet gaps with padding; retain quiet words', () => {
  const continuous = new Uint8Array(16000 * 2 * 25).fill(64)
  assert.equal(previewWindow(continuous).pcm.length, continuous.length)
  assert.equal(previewWindow(continuous).consumeSamples, 0)
  const paused = continuous.slice(); paused.fill(0, 16000 * 2 * 9, 16000 * 2 * 10)
  const window = previewWindow(paused)
  assert.equal(window.consumeSamples, 16000 * 9.35)
  assert.deepEqual(window.pcm, paused.subarray(0, window.consumeSamples * 2))
  const quiet = new Uint8Array(32000).fill(1)
  assert.equal(previewWindow(quiet).pcm.length, quiet.length)
  assert.equal(previewWindow(new Uint8Array(32000)).pcm.length, 0)
  const tail = new Uint8Array(32000 * 7); tail.set(new Uint8Array(32000 * 2).fill(64))
  assert.equal(previewWindow(tail).pcm.length, 32000 * 2.2)
})

test('caption silence: identical digital-silence tail does not re-decode or queue work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let count = 0, length = 32000 * 3
  const session = createLocalSpeechSession({
    capture: () => ({ async start() {}, async stop() { return new Uint8Array() }, cancel() {},
      preview() { const pcm = new Uint8Array(length); pcm.fill(64, 0, 32000 * 2); return pcm } }),
    async transcribe() { count++; return { ok: true, text: '끝까지 끝까지' } }, cancel: async () => {},
  }, () => {})
  sessions.push(session); session.start(); await flush()
  t.mock.timers.tick(2000); await flush(); assert.equal(count, 1)
  length = 32000 * 7; t.mock.timers.tick(2000); await flush()
  assert.equal(count, 1); assert.equal(session.getSnapshot().interimText, '끝까지 끝까지')
  assert.equal(session.getSnapshot().finalText, '')
})

test('caption cadence: 2-second first collection, slow work has cooldown instead of queued jobs', async t => {
  assert.equal(previewDelay(700), 1300)
  assert.equal(previewDelay(3500), 500)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness(); h.session.start(); await flush()
  t.mock.timers.tick(1999); await flush(); assert.equal(h.calls.requests, 0)
  t.mock.timers.tick(1); await flush(); assert.equal(h.calls.requests, 1)
  t.mock.timers.tick(30000); await flush(); assert.equal(h.calls.requests, 1)
  h.session.cancel(); h.resolve({ ok: true, text: 'late' }); await flush()
  t.mock.timers.tick(30000); assert.equal(h.calls.requests, 1)
})

test('end marker: edit is opt-in, exact last line only; spoken/typed/mid-sentence words remain intact', () => {
  const text = '반복합니다. 반복합니다.\n(끝)'
  assert.equal(endMarkerEdit(text, text), '반복합니다. 반복합니다.')
  for (const original of ['끝', '(끝)', '발언은 끝입니다.', '본문의 (끝) 표현입니다.', '본문 (끝)', '본문\n(끝)\n다음 문장']) {
    assert.equal(endMarkerEdit(original, original), null)
  }
  assert.equal(endMarkerEdit('사용자가 수정한 글\n(끝)', text), null)
})
function harness(options = {}) {
  const calls = { start: 0, stop: 0, cancel: 0, requests: 0 }, changes = []
  let resolveResult, interrupt
  const deps = {
    capture: callback => { interrupt = callback; return {
      async start() { calls.start++; await options.start?.() },
      async stop() { calls.stop++; return new Uint8Array(32000) },
      preview() { return new Uint8Array(32000).fill(64) },
      cancel() { calls.cancel++ },
    } },
    transcribe: async () => { calls.requests++; return new Promise(resolve => { resolveResult = resolve }) },
    cancel: async () => { calls.cancel++ },
  }
  const session = createLocalSpeechSession(deps, s => changes.push(s), options.seed ?? '')
  sessions.push(session)
  return { session, calls, changes, interrupt: () => interrupt(), resolve: value => resolveResult(value), get snapshot() { return session.getSnapshot() } }
}
test('local: one request after stop, final tail preserved, review required; no automatic submit', async () => {
  const h = harness({ seed: '직접 쓴 글\n' })
  h.session.start(); h.session.start(); await flush()
  const stopping = h.session.stop('submit'); await flush()
  await h.session.stop('submit')
  assert.equal(h.snapshot.phase, 'stopping')
  assert.equal(h.calls.requests, 1)
  h.resolve({ ok: true, text: '마지막 문장입니다.' }); await stopping
  assert.equal(h.snapshot.phase, 'review')
  assert.equal(h.snapshot.finalText, '직접 쓴 글\n마지막 문장입니다.')
  assert.equal(h.calls.start, 1)
})

test('local captions: continuous capture, sequential requests, replacement and genuine repetition preserved', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let starts = 0, stops = 0, available = 16000 * 3
  const requests = [], ranges = [], finalPCM = new Uint8Array(16000 * 2 * 25)
  const session = createLocalSpeechSession({
    capture: () => ({ async start() { starts++ }, async stop() { stops++; return finalPCM }, cancel() {},
      preview(offset, max) {
        ranges.push(offset)
        const recording = new Uint8Array(available * 2).fill(64)
        recording.fill(0, 16000 * 8 * 2, Math.min(recording.length, 16000 * 9 * 2))
        return recording.slice(offset * 2, (offset + max) * 2)
      } }),
    transcribe: (id, pcm) => new Promise(resolve => requests.push({ id, pcm, resolve })),
    cancel: async () => {},
  }, () => {}, '직접 쓴 내용')
  sessions.push(session); session.start(); await flush()
  t.mock.timers.tick(3000); await flush()
  t.mock.timers.tick(20000); await flush()
  assert.equal(requests.length, 1); assert.equal(starts, 1); assert.equal(stops, 0)
  requests[0].resolve({ ok: true, text: '지원해야 합니다.' }); await flush()
  assert.equal(session.getSnapshot().finalText, '직접 쓴 내용')
  assert.equal(session.getSnapshot().interimText, '지원해야 합니다.')
  available = 16000 * 12; t.mock.timers.tick(3000); await flush()
  requests[1].resolve({ ok: true, text: '지원해야 합니다. 지원해야 합니다.' }); await flush()
  assert.equal(session.getSnapshot().interimText, '지원해야 합니다. 지원해야 합니다.')
  available = 16000 * 15; t.mock.timers.tick(3000); await flush()
  assert.deepEqual(ranges, [0, 0, 16000 * 8.35])
  const stopping = session.stop('review'); await flush()
  requests[2].resolve({ ok: true, text: '늦은 임시 문장' }); await flush()
  assert.equal(requests.length, 4); assert.equal(requests[3].pcm, finalPCM)
  assert.ok(!session.getSnapshot().interimText.includes('늦은'))
  requests[3].resolve({ ok: true, text: '지원해야 합니다. 지원해야 합니다. 마지막입니다.' }); await stopping
  assert.equal(session.getSnapshot().interimText, '')
  assert.equal(session.getSnapshot().finalText, '직접 쓴 내용 지원해야 합니다. 지원해야 합니다. 마지막입니다.')
  t.mock.timers.tick(30000); await flush()
  assert.equal(requests.length, 4); assert.equal(stops, 1)
})

test('local captions: preview error keeps recording; cancel/dispose suppress late previews and timers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const action of ['cancel', 'dispose']) {
    const h = harness({ seed: '수정한 원문' }); h.session.start(); await flush()
    t.mock.timers.tick(3000); await flush()
    h.resolve({ ok: false, code: 'ENGINE_FAILED' }); await flush()
    assert.equal(h.snapshot.phase, 'listening'); assert.equal(h.calls.stop, 0)
    t.mock.timers.tick(3000); await flush()
    h.session[action](); const count = h.changes.length
    h.resolve({ ok: true, text: '취소된 자막' }); await flush()
    t.mock.timers.tick(30000); await flush()
    assert.equal(h.changes.length, count); assert.equal(h.calls.requests, 2)
    assert.equal(h.snapshot.finalText, '수정한 원문'); assert.equal(h.snapshot.interimText, '')
  }
})
test('local: rapid stop before permission resolves flushes exactly once', async () => {
  let ready
  const h = harness({ start: () => new Promise(resolve => { ready = resolve }) })
  h.session.start(); const stopping = h.session.stop('review')
  assert.equal(h.calls.stop, 0); ready(); await flush()
  assert.equal(h.calls.stop, 1)
  h.resolve({ ok: true, text: '확인' }); await stopping
  assert.equal(h.snapshot.finalText, '확인')
})
test('local: cancel/dispose discard even uncancellable late transcription and retain typed text', async () => {
  for (const action of ['cancel', 'dispose']) {
    const h = harness({ seed: '내 원문' }); h.session.start(); await flush()
    const stopping = h.session.stop('review'); await flush(); h.session[action]()
    const length = h.changes.length
    h.resolve({ ok: true, text: '늦은 결과' }); await stopping
    assert.equal(h.snapshot.finalText, '내 원문'); assert.equal(h.changes.length, length)
  }
})
test('local: silence never stops capture; device interruption processes once for review', async () => {
  const h = harness(); h.session.start(); await flush()
  assert.equal(h.snapshot.phase, 'listening'); assert.equal(h.calls.requests, 0)
  h.interrupt(); h.interrupt(); await flush()
  assert.equal(h.calls.requests, 1); h.resolve({ ok: true, text: '' }); await flush()
  assert.equal(h.snapshot.phase, 'review'); assert.equal(h.snapshot.finalText, '')
})
test('local: permission failure retains seed; delayed start after cancellation never listens', async () => {
  const denied = harness({ seed: '보존', start: () => { const e = new Error(); e.name = 'NotAllowedError'; throw e } })
  denied.session.start(); await flush()
  assert.equal(denied.snapshot.errorCode, 'not-allowed'); assert.equal(denied.snapshot.finalText, '보존')
  let ready; const h = harness({ start: () => new Promise(resolve => { ready = resolve }) })
  h.session.start(); h.session.dispose(); const length = h.changes.length; ready(); await flush()
  assert.equal(h.changes.length, length); assert.equal(h.calls.requests, 0)
})
test('local: recognition error/overflow never loses existing input or silently submits', async () => {
  for (const result of [{ ok: false, code: 'TIMEOUT' }, { ok: true, text: '가'.repeat(4100) }]) {
    const h = harness({ seed: '원문' }); h.session.start(); await flush()
    const stop = h.session.stop('submit'); await flush(); h.resolve(result); await stop
    assert.ok(h.snapshot.finalText.startsWith('원문'))
    if (result.ok) assert.ok(h.snapshot.overflowText.length > 100)
    else assert.equal(h.snapshot.phase, 'error')
  }
})
test('local: missing microphone is distinguished from speech engine errors', async () => {
  const h = harness({ start: () => { const e = new Error(); e.name = 'NotFoundError'; throw e } })
  h.session.start(); await flush()
  assert.equal(h.snapshot.phase, 'error'); assert.equal(h.snapshot.errorCode, 'audio-capture')
})
test('local WAV: bounded mono 16k PCM, final sample included, malformed payloads rejected', () => {
  const pcm = new Uint8Array([1, 0, 255, 127]), wav = wavFromPCM(pcm)
  assert.equal(wav.readUInt32LE(24), 16000); assert.equal(wav.readUInt16LE(22), 1)
  assert.equal(wav.readUInt32LE(40), 4); assert.deepEqual(wav.subarray(44), Buffer.from(pcm))
  for (const input of [null, 'path', [], new Uint8Array(1), new Uint8Array(MAX_AUDIO_BYTES + 2)]) assert.throws(() => wavFromPCM(input))
})
test('local service: fixed CPU/ko arguments, cancel/duplicate guard, audio cleanup and empty silence', async t => {
  await mkdir('.codex-debate', { recursive: true })
  const root = await mkdtemp(path.resolve('.codex-debate/whisper-test-'))
  const file = await open(path.join(root, 'ggml-base.bin'), 'w'); await file.truncate(147951465); await file.close()
  const vad = await open(path.join(root, VAD_MODEL), 'w'); await vad.truncate(VAD_BYTES); await vad.close()
  let child, args
  const service = createWhisperService({ dataRoot: root, assets: root, spawnProcess: (exe, argv, options) => {
    assert.equal(exe, path.join(root, 'whisper-cli.exe')); assert.equal(options.shell, false); assert.equal(options.stdio, 'ignore')
    args = argv; child = new EventEmitter(); child.kill = () => { setImmediate(() => child.emit('close', 1)); return true }; return child
  } })
  t.after(async () => { await service.close(); assert.ok(root.startsWith(path.resolve('.codex-debate') + path.sep)); await rm(root, { recursive: true, force: true }) })
  assert.deepEqual(await service.transcribe('silence', new Uint8Array(32000)), { ok: true, text: '' })
  assert.equal((await service.transcribe('../evil', new Uint8Array(4))).ok, false)
  const pcm = new Uint8Array(32000).fill(64)
  const first = service.transcribe('one', pcm)
  assert.equal((await service.transcribe('two', pcm)).code, 'BUSY')
  while (!child) await flush()
  assert.equal(args[args.indexOf('-l') + 1], 'ko'); assert.ok(args.includes('-ng'))
  assert.equal(args[args.indexOf('-m') + 1], 'ggml-base.bin') // Unicode Windows model-path regression
  assert.ok(!args.includes('-bs')); assert.ok(!args.includes('-nf'))
  assert.deepEqual(args.slice(-QUALITY_ARGS.length), QUALITY_ARGS)
  service.cancel('one'); assert.equal((await first).code, 'CANCELLED')
  assert.deepEqual(await readdir(path.join(root, 'speech-temp')), [])
  child = undefined
  const second = service.transcribe('three', pcm)
  while (!child) await flush()
  await writeFile(args[args.indexOf('-of') + 1] + '.txt', '한국어 결과\n')
  child.emit('close', 0)
  assert.deepEqual(await second, { ok: true, text: '한국어 결과' })
  child = undefined
  const preview = service.transcribe('four-preview', pcm)
  while (!child) await flush()
  assert.ok(!args.includes('-bs')); assert.ok(!args.includes('-nf')) // Accuracy also retained for captions.
  assert.deepEqual(args.slice(-QUALITY_ARGS.length), QUALITY_ARGS)
  await writeFile(args[args.indexOf('-of') + 1] + '.txt', '그대로 보존\n(끝)')
  child.emit('close', 0)
  assert.deepEqual(await preview, { ok: true, text: '그대로 보존\n(끝)' })
  assert.deepEqual(await readdir(path.join(root, 'speech-temp')), [])
  await service.close(); assert.equal((await service.transcribe('closed', pcm)).code, 'CANCELLED')
})
