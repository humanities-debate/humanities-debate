import assert from 'node:assert/strict'
import test from 'node:test'
import { debateReducer, initialState, participantView, elapsedSeconds, MAX_INPUT_LENGTH, AI_TYPING_MS } from '../src/logic/debate.ts'
import { scheduleTurn } from '../src/logic/turnScheduler.ts'
import { mockAIProvider } from '../src/providers/MockAIProvider.ts'
import { decisionTopic } from '../src/data/topics.ts'

const DEFAULT_WAIT_MS = 10000

async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}
function harness(t, provider = mockAIProvider) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
  let state = initialState
  let cancel = () => {}
  let delivered = 0
  function dispatch(action) {
    delivered++
    const previous = state
    state = debateReducer(state, action)
    if (previous.status !== state.status || previous.generationId !== state.generationId ||
        previous.pending !== state.pending || previous.waitUntil !== state.waitUntil) {
      cancel()
      cancel = scheduleTurn(state, dispatch, provider)
    }
  }
  t.after(() => cancel())
  return {
    get state() { return state },
    get delivered() { return delivered },
    send(type, extras = {}) { dispatch({ type, topic: decisionTopic, generationId: state.generationId, timestamp: Date.now(), ...extras }) },
    async tick(ms) { await flush(); t.mock.timers.tick(ms); await flush() },
    dispose() { cancel() },
    restartEffect() { cancel(); cancel = scheduleTurn(state, dispatch, provider) },
  }
}
function finishUser(h, text) {
  h.send('DRAFT', { text })
  h.send('USER_FINISH')
}

test('automatic discussion: 5-second typing, full 10-second window, balanced non-fixed AI turns', async (t) => {
  const h = harness(t)
  h.send('START')
  assert.equal(h.state.status, 'aiTyping')
  await h.tick(AI_TYPING_MS - 1)
  assert.equal(h.state.history.length, 0)
  await h.tick(1)
  assert.equal(h.state.history.length, 1)
  for (let i = 1; i < 12; i++) {
    await h.tick(DEFAULT_WAIT_MS - 1)
    assert.equal(h.state.status, 'aiShowing')
    assert.equal(h.state.history.length, i)
    await h.tick(1)
    assert.equal(h.state.status, 'aiTyping')
    await h.tick(AI_TYPING_MS)
    assert.equal(h.state.history.length, i + 1)
  }
  const ids = h.state.history.map(m => m.speakerId)
  assert.ok(ids.every((id, index) => id !== ids[index - 1] && id !== 'user'))
  assert.ok(ids.some((id, index) => index >= 3 && id !== ids[index % 3]))
  for (const id of ['ai1', 'ai2', 'ai3']) assert.equal(ids.filter(item => item === id).length, 4)
  assert.equal(new Set(h.state.history.map(m => m.id)).size, 12)
})

test('interrupt typing and hold user input for 30 seconds; blank input cannot finish', async (t) => {
  const h = harness(t)
  h.send('START')
  await h.tick(AI_TYPING_MS)
  await h.tick(DEFAULT_WAIT_MS)
  assert.equal(h.state.pending.speakerId, 'ai2')
  const cancelledGeneration = h.state.generationId
  h.send('USER_START')
  h.send('DRAFT', { text: '   ' })
  h.send('USER_FINISH')
  await h.tick(30000)
  assert.equal(h.state.status, 'userSpeaking')
  assert.equal(h.state.history.length, 1)
  h.send('AI_READY', { generationId: cancelledGeneration, text: 'cancelled response' })
  assert.equal(h.state.history.length, 1)
  const userText = '최종 책임은 사람이 맡아야 합니다.\n재검토 절차가 필요합니다.'
  finishUser(h, userText)
  assert.equal(h.state.history.at(-1).text, userText)
  assert.equal(h.state.history.at(-1).source, 'text')
  assert.equal(h.state.status, 'aiTyping')
  assert.equal(h.state.waitUntil, null)
  assert.equal(h.state.pending.history.at(-1).text, userText)
  await h.tick(AI_TYPING_MS)
  const reply = h.state.history.at(-1)
  assert.match(reply.text, /최종 책임은 사람이 맡아야 합니다/)
  assert.equal(reply.replyToId, h.state.history.at(-2).id)
  assert.equal(reply.source, 'mock')
})

test('interrupt during 10-second opportunity; cancelling empty input resumes without inventing user speech', async (t) => {
  const h = harness(t)
  h.send('START')
  await h.tick(AI_TYPING_MS)
  await h.tick(DEFAULT_WAIT_MS - 1)
  h.send('USER_START')
  await h.tick(30000)
  assert.equal(h.state.history.length, 1)
  h.send('USER_CANCEL')
  await h.tick(DEFAULT_WAIT_MS)
  await h.tick(AI_TYPING_MS)
  assert.equal(h.state.history.length, 2)
  assert.ok(h.state.history.every(m => !m.isUser))
})

test('normal/practice visibility preserves original log and mode changes do not reset timers', async (t) => {
  const h = harness(t)
  h.send('START')
  await h.tick(AI_TYPING_MS)
  await h.tick(DEFAULT_WAIT_MS - 1000)
  const before = h.state.history
  h.send('MODE', { mode: 'practice' })
  assert.equal(h.state.history, before)
  await h.tick(1000)
  assert.equal(h.state.status, 'aiTyping')
  assert.equal(participantView(h.state, 'ai1').hidden, true)
  await h.tick(AI_TYPING_MS)
  assert.equal(participantView(h.state, 'ai2').hidden, false)
  const history = h.state.history
  h.send('MODE', { mode: 'normal' })
  assert.equal(participantView(h.state, 'ai1').hidden, false)
  assert.equal(h.state.history, history)
  assert.equal(['user', 'ai1', 'ai2', 'ai3'].filter(id => participantView(h.state, id).active).length, 1)
  h.send('USER_START')
  h.send('MODE', { mode: 'practice' })
  assert.equal(participantView(h.state, 'ai1').hidden, true)
  assert.equal(participantView(h.state, 'ai2').hidden, true)
})

test('end stops both typing and automatic windows; restart rejects stale generations', async (t) => {
  const h = harness(t)
  h.send('START')
  const stale = h.state.generationId
  h.send('END')
  const deliveries = h.delivered
  await h.tick(30000)
  assert.equal(h.delivered, deliveries)
  assert.equal(h.state.history.length, 0)
  h.send('START')
  h.send('AI_READY', { generationId: stale, text: 'late response from old session' })
  assert.equal(h.state.history.length, 0)
  await h.tick(AI_TYPING_MS)
  const history = h.state.history
  h.send('END')
  const endingElapsed = elapsedSeconds(h.state, Date.now())
  const lastDeliveries = h.delivered
  await h.tick(30000)
  assert.equal(h.delivered, lastDeliveries)
  assert.equal(h.state.history, history)
  assert.equal(elapsedSeconds(h.state, Date.now()), endingElapsed)
  h.send('START')
  assert.equal(h.state.history, history)
  assert.equal(participantView(h.state, 'ai1').message, undefined)
  await h.tick(AI_TYPING_MS)
  assert.equal(h.state.history.length, 2)
  assert.notEqual(h.state.history[0].sessionId, h.state.history[1].sessionId)
})

test('rapid repeated starts, next actions and submits never duplicate messages', async (t) => {
  const h = harness(t)
  for (let i = 0; i < 10; i++) h.send('START')
  assert.equal(h.state.sessionId, 1)
  await h.tick(AI_TYPING_MS)
  const token = h.state.generationId
  for (let i = 0; i < 10; i++) h.send('NEXT', { generationId: token })
  const aiToken = h.state.generationId
  h.send('USER_START')
  for (let i = 0; i < 10; i++) h.send('USER_START')
  const userToken = h.state.generationId
  h.send('DRAFT', { text: '이의 제기 절차가 필요합니다.' })
  for (let i = 0; i < 10; i++) h.send('USER_FINISH', { generationId: userToken })
  h.send('AI_READY', { generationId: aiToken, text: 'cancelled' })
  assert.equal(h.state.history.length, 2)
  assert.equal(h.state.status, 'aiTyping')
  await h.tick(AI_TYPING_MS)
  assert.equal(h.state.history.length, 3)
  assert.deepEqual(h.state.history.map(m => m.turnId), [1, 2, 3])
})

test('pause/resume cancels pending work, preserves draft, and excludes paused time', async (t) => {
  const h = harness(t)
  h.send('START')
  await h.tick(1000)
  h.send('PAUSE')
  assert.equal(elapsedSeconds(h.state, Date.now()), 1)
  await h.tick(30000)
  assert.equal(h.state.history.length, 0)
  assert.equal(elapsedSeconds(h.state, Date.now()), 1)
  h.send('RESUME')
  await h.tick(AI_TYPING_MS - 1)
  assert.equal(h.state.history.length, 0)
  await h.tick(1)
  assert.equal(h.state.history.length, 1)
  assert.equal(elapsedSeconds(h.state, Date.now()), 1 + AI_TYPING_MS / 1000)
  h.send('PAUSE')
  await h.tick(30000)
  h.send('RESUME')
  await h.tick(DEFAULT_WAIT_MS - 1)
  assert.equal(h.state.status, 'aiShowing')
  h.send('USER_START')
  h.send('DRAFT', { text: '보존할 초안' })
  h.send('PAUSE')
  await h.tick(30000)
  h.send('RESUME')
  assert.equal(h.state.status, 'userSpeaking')
  assert.equal(h.state.draft, '보존할 초안')
  h.send('PAUSE')
  await h.tick(10000)
  const elapsed = elapsedSeconds(h.state, Date.now())
  h.send('END')
  assert.equal(elapsedSeconds(h.state, Date.now()), elapsed)
})

test('unmount/StrictMode cleanup aborts requests and only the active effect publishes', async (t) => {
  const signals = []
  const provider = { async generateReply(request, signal) {
    signals.push(signal)
    return mockAIProvider.generateReply(request, signal)
  } }
  const h = harness(t, provider)
  h.send('START')
  await flush()
  h.restartEffect()
  assert.equal(signals[0].aborted, true)
  await h.tick(AI_TYPING_MS)
  assert.equal(h.state.history.length, 1)
  h.dispose()
  const delivered = h.delivered
  await h.tick(30000)
  assert.equal(h.delivered, delivered)
})

test('late provider response that ignores AbortSignal cannot publish or enter a new session', async (t) => {
  const resolvers = []
  const signals = []
  const provider = { generateReply(_request, signal) {
    signals.push(signal)
    return new Promise(resolve => resolvers.push(resolve))
  } }
  const h = harness(t, provider)
  h.send('START')
  await h.tick(AI_TYPING_MS)
  h.send('USER_START')
  assert.equal(signals[0].aborted, true)
  resolvers[0]({ text: 'cancelled AI output' })
  await flush()
  assert.equal(h.state.history.length, 0)
  finishUser(h, '새로운 사용자 발언')
  assert.equal(h.state.status, 'aiTyping')
  await h.tick(AI_TYPING_MS)
  h.send('END')
  h.send('START')
  resolvers[1]({ text: 'previous session output' })
  await flush()
  assert.equal(h.state.history.length, 1)
  await h.tick(AI_TYPING_MS)
  resolvers[2]({ text: 'current session output' })
  await flush()
  assert.equal(h.state.history.length, 2)
  assert.equal(h.state.history.at(-1).text, 'current session output')
})

test('provider failures pause honestly and clear scheduled timers', async (t) => {
  const provider = { async generateReply() { throw new Error('test failure') } }
  const h = harness(t, provider)
  h.send('START')
  await flush()
  assert.equal(h.state.status, 'paused')
  assert.ok(h.state.error)
  const delivered = h.delivered
  await h.tick(30000)
  assert.equal(h.delivered, delivered)
  assert.equal(h.state.history.length, 0)
})

test('input limit and metadata; stale timeout events cannot interrupt user input', async (t) => {
  const h = harness(t)
  h.send('START')
  await h.tick(AI_TYPING_MS)
  const previousGeneration = h.state.generationId
  h.send('USER_START')
  h.send('DRAFT', { text: '가'.repeat(MAX_INPUT_LENGTH + 10) })
  assert.equal(h.state.draft.length, MAX_INPUT_LENGTH)
  h.send('WAIT_ELAPSED', { generationId: previousGeneration, timestamp: Date.now() + DEFAULT_WAIT_MS })
  assert.equal(h.state.status, 'userSpeaking')
  h.send('USER_FINISH')
  const message = h.state.history.at(-1)
  assert.equal(message.speakerId, 'user')
  assert.equal(message.isUser, true)
  assert.equal(message.turnId, 2)
  assert.equal(message.timestamp, Date.now())
  assert.equal(message.replyToId, 'msg-1')
})

test('previous speech stays hidden when its speaker begins a new cancelled turn', async (t) => {
  const h = harness(t)
  h.send('START')
  await h.tick(AI_TYPING_MS)
  h.send('USER_START')
  finishUser(h, '첫 번째 의견')
  h.send('MODE', { mode: 'practice' })
  h.send('USER_START')
  h.send('USER_CANCEL')
  assert.equal(participantView(h.state, 'user').hidden, true)
  assert.equal(h.state.history.at(-1).text, '첫 번째 의견')
})

for (const seconds of [5, 10, 20, 30, 40, 50]) {
  test('selected ' + seconds + '-second wait applies only after AI; user completion prepares AI immediately', async (t) => {
    const h = harness(t)
    assert.equal(h.state.waitSeconds, 10)
    assert.equal(AI_TYPING_MS, 5000)
    h.send('WAIT_SETTING', { seconds })
    h.send('START')
    await h.tick(4999)
    assert.equal(h.state.history.length, 0)
    await h.tick(1)
    const deadline = Date.now() + seconds * 1000
    assert.equal(h.state.waitUntil, deadline)
    await h.tick(seconds * 1000 - 1)
    assert.equal(h.state.status, 'aiShowing')
    await h.tick(1)
    assert.equal(h.state.status, 'aiTyping')
    h.send('USER_START')
    await h.tick(60000)
    assert.equal(h.state.history.length, 1)
    finishUser(h, '사용자의 새 의견')
    assert.equal(h.state.waitUntil, null)
    assert.equal(h.state.status, 'aiTyping')
    assert.equal(h.state.pending.history.at(-1).text, '사용자의 새 의견')
    await h.tick(4999)
    assert.equal(h.state.history.length, 2)
    await h.tick(1)
    assert.equal(h.state.history.length, 3)
    assert.equal(h.state.waitUntil, Date.now() + seconds * 1000)
    h.send('END')
    h.send('START')
    assert.equal(h.state.waitSeconds, seconds)
  })
}

test('changing an active wait resets its deadline and invalidates the old timer', async (t) => {
  const h = harness(t)
  h.send('START')
  await h.tick(AI_TYPING_MS)
  const staleGeneration = h.state.generationId
  await h.tick(DEFAULT_WAIT_MS - 1000)
  h.send('WAIT_SETTING', { seconds: 40 })
  assert.equal(h.state.waitUntil, Date.now() + 40000)
  h.send('WAIT_ELAPSED', { generationId: staleGeneration, timestamp: Date.now() + 1000 })
  await h.tick(1000)
  assert.equal(h.state.status, 'aiShowing')
  await h.tick(38999)
  assert.equal(h.state.status, 'aiShowing')
  await h.tick(1)
  assert.equal(h.state.status, 'aiTyping')
})

test('settings do not restart typing or interrupt input; paused resume uses latest setting', async (t) => {
  const h = harness(t)
  h.send('START')
  await h.tick(4000)
  const generation = h.state.generationId
  h.send('WAIT_SETTING', { seconds: 30 })
  assert.equal(h.state.generationId, generation)
  await h.tick(1000)
  assert.equal(h.state.history.length, 1)
  assert.equal(h.state.waitUntil, Date.now() + 30000)
  h.send('USER_START')
  h.send('DRAFT', { text: '입력 중인 의견' })
  h.send('WAIT_SETTING', { seconds: 50 })
  await h.tick(60000)
  assert.equal(h.state.status, 'userSpeaking')
  assert.equal(h.state.draft, '입력 중인 의견')
  h.send('USER_FINISH')
  assert.equal(h.state.status, 'aiTyping')
  assert.equal(h.state.waitUntil, null)
  await h.tick(AI_TYPING_MS)
  assert.equal(h.state.waitUntil, Date.now() + 50000)
  h.send('PAUSE')
  h.send('WAIT_SETTING', { seconds: 40 })
  await h.tick(60000)
  h.send('RESUME')
  assert.equal(h.state.waitUntil, Date.now() + 40000)
  await h.tick(39999)
  assert.equal(h.state.status, 'aiShowing')
  await h.tick(1)
  assert.equal(h.state.status, 'aiTyping')
})

test('invalid or unchanged settings leave existing timer and state untouched', async (t) => {
  const h = harness(t)
  h.send('START')
  await h.tick(AI_TYPING_MS)
  const state = h.state
  for (const seconds of [10, 0, -1, 25, NaN, Infinity]) {
    h.send('WAIT_SETTING', { seconds })
    assert.equal(h.state, state)
  }
})

test('immediate reply can be interrupted again; cancelled preparation never publishes', async (t) => {
  const h = harness(t)
  h.send('START')
  await h.tick(AI_TYPING_MS)
  h.send('USER_START')
  finishUser(h, '첫 번째 의견')
  const oldPreparation = h.state.generationId
  await h.tick(4000)
  h.send('USER_START')
  finishUser(h, '수정된 두 번째 의견')
  h.send('AI_READY', { generationId: oldPreparation, text: '취소된 응답' })
  await h.tick(1000)
  assert.equal(h.state.history.length, 3)
  assert.equal(h.state.status, 'aiTyping')
  await h.tick(4000)
  assert.equal(h.state.history.length, 4)
  assert.match(h.state.history.at(-1).text, /수정된 두 번째 의견/)
  await h.tick(DEFAULT_WAIT_MS - 1)
  assert.equal(h.state.history.length, 4)
  assert.equal(h.state.status, 'aiShowing')
})

test('duplicate empty voice completions create only one resumed wait and no user record', async (t) => {
  const h = harness(t)
  h.send('START')
  h.send('USER_START')
  const voiceGeneration = h.state.generationId
  for (let i = 0; i < 10; i++) h.send('VOICE_FINISH', { generationId: voiceGeneration, text: '  ' })
  assert.equal(h.state.history.length, 0)
  await h.tick(DEFAULT_WAIT_MS - 1)
  assert.equal(h.state.status, 'aiShowing')
  await h.tick(1)
  assert.equal(h.state.status, 'aiTyping')
  await h.tick(AI_TYPING_MS)
  assert.equal(h.state.history.length, 1)
  assert.equal(h.state.history[0].isUser, false)
})

test('end rejects late voice completion and cancels an immediate user-triggered reply', async (t) => {
  const h = harness(t)
  h.send('START')
  h.send('USER_START')
  const voiceGeneration = h.state.generationId
  h.send('VOICE_FINISH', { generationId: voiceGeneration, text: '최종 음성 의견' })
  assert.equal(h.state.status, 'aiTyping')
  h.send('END')
  const history = h.state.history
  h.send('VOICE_FINISH', { generationId: voiceGeneration, text: '늦게 온 중복 결과' })
  const delivered = h.delivered
  await h.tick(60000)
  assert.equal(h.state.history, history)
  assert.equal(h.state.status, 'finished')
  assert.equal(h.delivered, delivered)
})
