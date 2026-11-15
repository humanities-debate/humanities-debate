import test from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { createDebateServer } from '../server/http.mjs'
import { buildPrompt, validateRequest, validateReply, DebateError } from '../server/dialogue.mjs'
import { debateReducer, initialState, AI_TYPING_MS } from '../src/logic/debate.ts'
import { scheduleTurn } from '../src/logic/turnScheduler.ts'
import { decisionTopic } from '../src/data/topics.ts'

const message = (id, speakerId, text) => ({ id: `msg-${id}`, turnId: id, speakerId, text, isUser: speakerId === 'user' })
const input = { speakerId: 'ai2', topic: 'AI가 인간의 최종 결정을 대신해도 되는가?', history: [message(1, 'ai1', '정확성뿐 아니라 책임의 소재를 고려해야 합니다.'), message(2, 'user', '응급실에서는 승인 대기가 오히려 위험할 수 있습니다.')] }
async function fixture(t, generate) {
  const app = createDebateServer(generate)
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  t.after(() => app.close())
  const base = `http://127.0.0.1:${app.server.address().port}`
  const headers = { 'X-Debate-Client': 'local-ui', 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' }
  const session = await fetch(base + '/api/session', { headers }).then(r => r.json())
  headers['X-Debate-Token'] = session.token
  return { app, base, headers,
    post: (route, body, signal) => fetch(base + '/api/' + route, { method: 'POST', headers, body: JSON.stringify(body), signal }) }
}
test('prompt carries all three personalities, prior positions, topic, recent and last user context', () => {
  const request = validateRequest(input)
  const prompt = buildPrompt(request)
  for (const term of ['김지훈', '이서연', '박민수', '구어체', 'previousPositionIds', 'lastUserMessageId', input.topic, input.history[1].text, '매번 반대하지']) assert.ok(prompt.includes(term), term)
  // Only the assigned speaker's full directions are active; others remain context.
  for (const [speakerId, name, style] of [['ai1', '김지훈', '차분'], ['ai2', '이서연', '구어체'], ['ai3', '박민수', '부드럽']]) {
    const assigned = buildPrompt({ ...request, speakerId })
    assert.ok(assigned.includes(`이번에 말할 사람은 ${name}(${speakerId})`))
    assert.ok(assigned.includes(style))
    const data = JSON.parse(assigned.split('\n').at(-1))
    assert.equal(data.respondToId, request.history.at(-1).id)
    assert.ok(data.participants.every(person => !Object.hasOwn(person, 'rules')))
    assert.deepEqual(data.participants.find(person => person.id === 'ai1').previousPositionIds, request.history.filter(m => m.speakerId === 'ai1').map(m => m.id))
  }
  const long = { ...request, history: Array.from({ length: 20 }, (_, i) => message(i + 1, i % 2 ? 'ai1' : 'user', `${i}번째 근거` + '가'.repeat(350))) }
  const data = JSON.parse(buildPrompt(long).split('\n').at(-1))
  assert.equal(data.earlierContext.length, 8)
  assert.equal(data.recentMessages.length, 12)
  assert.equal(data.earlierContext[0].excerpt, true)
  assert.equal(data.respondToId, long.history.at(-1).id)
  assert.notEqual(data.respondToId, data.lastUserMessageId)
})
test('input and generated output validation reject malformed, wrong speaker, duplicate and long data', () => {
  assert.throws(() => validateRequest({ ...input, speakerId: '__proto__' }))
  assert.throws(() => validateRequest({ ...input, history: [input.history[0], input.history[0]] }))
  assert.throws(() => validateRequest({ ...input, topic: 'a'.repeat(301) }))
  assert.throws(() => validateReply('not JSON', input))
  assert.throws(() => validateReply(JSON.stringify({ speakerId: 'ai1', text: '다른 사람' }), input))
  assert.throws(() => validateReply(JSON.stringify({ speakerId: 'ai2', text: input.history[0].text }), input), /REPETITION/)
  assert.deepEqual(validateReply(JSON.stringify({ speakerId: 'ai2', text: '응급실의 시간 제한은 별도로 고려해야 해요.' }), input), { speakerId: 'ai2', text: '응급실의 시간 제한은 별도로 고려해야 해요.' })
})
test('HTTP accepts a structured turn exactly once; rejects foreign origin, missing capability and rebinding host', async t => {
  let calls = 0
  const f = await fixture(t, async () => { calls++; return { speakerId: 'ai2', text: '새로운 응답' } })
  const body = { id: 'turn-1', request: input }
  const result = await f.post('turn', body)
  assert.equal(result.status, 200)
  assert.equal((await result.json()).id, 'turn-1')
  assert.equal((await f.post('turn', body)).status, 409)
  for (const headers of [{ ...f.headers, Origin: 'https://example.com' }, { ...f.headers, 'X-Debate-Token': '' }]) {
    assert.equal((await fetch(f.base + '/api/turn', { method: 'POST', headers, body: JSON.stringify({ ...body, id: 'turn-2' }) })).status, 403)
  }
  // Node fetch normalizes Host; raw HTTP is required to exercise DNS rebinding checks.
  const rebound = await new Promise((resolve, reject) => {
    const req = httpRequest(f.base + '/api/session', { headers: { ...f.headers, Host: 'evil.test' } }, res => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject)
    req.end()
  })
  assert.equal(rebound, 403)
  assert.equal(calls, 1)
})
test('cancel before arrival prevents SDK execution; cancelling active turn aborts it', async t => {
  let started
  const began = new Promise(resolve => { started = resolve })
  let aborted = false
  let calls = 0
  const f = await fixture(t, async (_, signal) => {
    calls++; started()
    await new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true }))
    return { speakerId: 'ai2', text: 'late' } // Even an abort-ignoring result must be rejected.
  })
  await f.post('cancel', { id: 'before' })
  assert.equal((await f.post('turn', { id: 'before', request: input })).status, 409)
  assert.equal(calls, 0)
  const pending = f.post('turn', { id: 'active', request: input })
  await began
  await f.post('cancel', { id: 'active' })
  assert.equal((await pending).status, 409)
  assert.equal(aborted, true)
})
test('disconnected browser and server shutdown both abort active generation', async t => {
  for (const mode of ['disconnect', 'shutdown']) {
    let start
    const began = new Promise(resolve => { start = resolve })
    let finish
    const stopped = new Promise(resolve => { finish = resolve })
    const f = await fixture(t, async (_, signal) => {
      start()
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      finish()
      throw new DebateError('CANCELLED')
    })
    const abort = new AbortController()
    const pending = f.post('turn', { id: mode, request: input }, abort.signal).catch(() => null)
    await began
    if (mode === 'disconnect') abort.abort()
    else await f.app.close()
    await stopped
    await pending
  }
})
test('errors expose safe codes, never SDK stderr or credentials', async t => {
  const f = await fixture(t, async () => { throw new Error('Bearer secret-value') })
  const result = await f.post('turn', { id: 'failure', request: input })
  assert.equal(result.status, 503)
  assert.deepEqual(await result.json(), { error: 'AI_UNAVAILABLE' })
})
test('real engine records source, preserves history across paused mode switch and rejects old responses', () => {
  let state = debateReducer(initialState, { type: 'ENGINE', engine: 'real' })
  state = debateReducer(state, { type: 'MODEL_SETTINGS', settings: { model: 'gpt-6.1-sol', reasoningEffort: 'medium' } })
  state = debateReducer(state, { type: 'START', topic: decisionTopic, timestamp: 0 })
  assert.equal(state.engine, 'real')
  const generationId = state.generationId
  state = debateReducer(state, { type: 'AI_READY', text: '실제 생성', generationId, timestamp: 5000 })
  assert.equal(state.history[0].source, 'real')
  assert.equal(debateReducer(state, { type: 'ENGINE', engine: 'mock' }), state)
  state = debateReducer(state, { type: 'PAUSE', timestamp: 6000 })
  const history = state.history
  state = debateReducer(state, { type: 'ENGINE', engine: 'mock' })
  assert.equal(state.history, history)
  assert.equal(debateReducer(state, { type: 'AI_READY', text: 'stale', generationId, timestamp: 7000 }), state)
})
test('AI response slower than five seconds stays preparing; user finish starts a fresh request immediately', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
  let state = debateReducer(initialState, { type: 'START', topic: decisionTopic, timestamp: 1000 })
  let resolve
  const reply = new Promise(done => { resolve = done })
  let calls = 0
  const provider = { generateReply: () => { calls++; return reply } }
  const dispatch = action => { state = debateReducer(state, action) }
  const cancel = scheduleTurn(state, dispatch, provider)
  t.after(cancel)
  await Promise.resolve()
  t.mock.timers.tick(AI_TYPING_MS + 1000)
  await Promise.resolve()
  assert.equal(state.status, 'aiTyping')
  state = debateReducer(state, { type: 'USER_START', timestamp: Date.now() })
  cancel()
  state = debateReducer(state, { type: 'DRAFT', text: '새로운 사용자 근거' })
  state = debateReducer(state, { type: 'USER_FINISH', generationId: state.generationId, timestamp: Date.now() })
  assert.equal(state.waitUntil, null)
  assert.equal(state.pending.history.at(-1).text, '새로운 사용자 근거')
  const cancelNew = scheduleTurn(state, dispatch, provider)
  t.after(cancelNew)
  await Promise.resolve()
  assert.equal(calls, 2)
  resolve({ text: '새로운 응답' })
  for (let i = 0; i < 10; i++) await Promise.resolve()
  assert.equal(state.history.length, 1)
  t.mock.timers.tick(AI_TYPING_MS)
  for (let i = 0; i < 10; i++) await Promise.resolve()
  assert.equal(state.history.length, 2)
})
