import test from 'node:test'
import assert from 'node:assert/strict'
import { createPCMCapture } from '../src/speech/pcmCapture.ts'

function environment(t, getStream) {
  const events = [], track = { stop() { events.push('track-stop') }, onended: null }
  let node
  class Context {
    sampleRate = 16000
    destination = {}
    audioWorklet = { addModule: async () => { events.push('module-ready') } }
    createMediaStreamSource() { return { connect() { events.push('connected') } } }
    async resume() { events.push('resumed') }
    async close() { events.push('closed') }
  }
  class Worklet {
    constructor() {
      node = this
      this.port = { onmessage: null, postMessage: () => queueMicrotask(() => {
        this.port.onmessage({ data: { pcm: new Int16Array([32767, -32768]) } })
        this.port.onmessage({ data: { ended: true } })
      }) }
    }
    connect() {}
    disconnect() {}
  }
  for (const [key, value] of Object.entries({ AudioContext: Context, AudioWorkletNode: Worklet,
    navigator: { mediaDevices: { getUserMedia: async constraints => {
      assert.equal(constraints.video, false); events.push('microphone-open')
      await getStream?.(); return { getTracks: () => [track], getAudioTracks: () => [track] }
    } } },
  })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, value })
    t.after(() => { if (original) Object.defineProperty(globalThis, key, original); else delete globalThis[key] })
  }
  return { events, get node() { return node } }
}
test('PCM: processor ready before microphone opens, stop includes final pending audio in order', async t => {
  const env = environment(t), capture = createPCMCapture(() => {})
  t.after(() => capture.cancel())
  await capture.start()
  assert.ok(env.events.indexOf('module-ready') < env.events.indexOf('microphone-open'))
  env.node.port.onmessage({ data: { pcm: new Int16Array([1, 2]) } })
  const preview = capture.preview(0, 2)
  assert.equal(new DataView(preview.buffer).getInt16(2, true), 2)
  preview.fill(0) // Mutating a preview cannot change the full recording.
  assert.equal(new DataView(capture.preview(1, 10).buffer).getInt16(0, true), 2)
  assert.ok(!env.events.includes('track-stop'))
  const bytes = await capture.stop(), view = new DataView(bytes.buffer)
  assert.deepEqual([0, 2, 4, 6].map(i => view.getInt16(i, true)), [1, 2, 32767, -32768])
  assert.ok(env.events.includes('track-stop')); assert.ok(env.events.includes('closed'))
})
test('PCM: permission resolves after cancellation; newly obtained track is immediately stopped', async t => {
  let allow
  const env = environment(t, () => new Promise(resolve => { allow = resolve })), capture = createPCMCapture(() => {})
  const started = capture.start(); await new Promise(resolve => setImmediate(resolve))
  capture.cancel(); allow(); await started
  assert.ok(env.events.includes('track-stop')); assert.ok(!env.events.includes('connected'))
})
