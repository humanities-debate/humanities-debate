import assert from 'node:assert/strict'
import test from 'node:test'
import { localAIProvider } from '../src/providers/LocalAIProvider.ts'
import { AIProviderError } from '../src/providers/AIProvider.ts'

const request = { speakerId: 'ai3', topic: '환경과 경제의 균형', history: [], persona: { private: 'not sent' }, modelSettings: { model: 'gpt-6.1-sol', reasoningEffort: 'medium' } }
const json = (value, status = 200) => new Response(JSON.stringify(value), { status })

test('local provider sends only debate data and verifies reply identity', async t => {
  let posted
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === '/api/session') return json({ token: 'local-capability' })
    posted = JSON.parse(options.body)
    assert.equal(options.headers['X-Debate-Token'], 'local-capability')
    assert.deepEqual(Object.keys(posted.request), ['speakerId', 'topic', 'history', 'modelSettings'])
    assert.deepEqual(posted.request.modelSettings, request.modelSettings)
    return json({ id: posted.id, speakerId: 'ai3', text: '환경 피해를 줄이는 전환 비용도 함께 나눠야 해요.', ...request.modelSettings })
  })
  const result = await localAIProvider.generateReply(request, new AbortController().signal)
  assert.ok(posted.id)
  assert.match(result.text, /전환 비용/)
})
test('user interruption aborts fetch and explicitly cancels the same server request', async t => {
  let start
  const began = new Promise(resolve => { start = resolve })
  let postedId
  let cancelledId
  let transportSignal
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === '/api/session') return json({ token: 'local-capability' })
    if (url === '/api/cancel') { cancelledId = JSON.parse(options.body).id; return json({ cancelled: true }) }
    postedId = JSON.parse(options.body).id
    transportSignal = options.signal
    start()
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
  })
  const controller = new AbortController()
  const result = localAIProvider.generateReply(request, controller.signal)
  await began
  controller.abort()
  await assert.rejects(result, { name: 'AbortError' })
  assert.equal(transportSignal.aborted, true)
  assert.equal(cancelledId, postedId)
})
test('pre-cancelled requests never reach local server', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('unexpected') })
  await assert.rejects(localAIProvider.generateReply(request, AbortSignal.abort()), { name: 'AbortError' })
  assert.equal(calls, 0)
})
test('wrong response id/speaker and safe service error codes fail visibly', async t => {
  for (const mode of ['id', 'speaker', 'login', 'unknown', 'model', 'effort', 'unsupported']) {
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      if (url === '/api/session') return json({ token: 'local-capability' })
      const { id } = JSON.parse(options.body)
      if (mode === 'login') return json({ error: 'CHATGPT_LOGIN_REQUIRED' }, 503)
      if (mode === 'unknown') return json({ error: 'Bearer must-not-leak' }, 503)
      if (mode === 'unsupported') return json({ error: 'UNSUPPORTED_MODEL_SETTINGS' }, 400)
      return json({ id: mode === 'id' ? 'stale' : id, speakerId: mode === 'speaker' ? 'ai1' : 'ai3', text: '발언',
        model: mode === 'model' ? 'gpt-6-luna' : request.modelSettings.model,
        reasoningEffort: mode === 'effort' ? 'high' : request.modelSettings.reasoningEffort })
    })
    await assert.rejects(localAIProvider.generateReply(request, new AbortController().signal), error => {
      assert.ok(error instanceof AIProviderError)
      assert.ok(!error.message.includes('must-not-leak'))
      if (mode === 'login') assert.match(error.message, /로그인/)
      if (mode === 'model' || mode === 'effort') assert.match(error.message, /설정과 응답 정보가 달라/)
      if (mode === 'unsupported') assert.match(error.message, /지원되지 않습니다/)
      return true
    })
    t.mock.restoreAll()
  }
})
