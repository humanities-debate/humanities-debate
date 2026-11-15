import assert from 'node:assert/strict'
import test from 'node:test'
import { practiceTopics, decisionTopic } from '../src/data/topics.ts'
import { customTopic, drawTopic, initialTopicSelection, selectionPreview, topicForStart, MAX_TOPIC_LENGTH } from '../src/logic/topics.ts'
import { debateReducer, initialState, participantView, elapsedSeconds } from '../src/logic/debate.ts'
import { scheduleTurn } from '../src/logic/turnScheduler.ts'
import { createMockReply } from '../src/providers/MockAIProvider.ts'
import { personas, conversationRules } from '../src/data/personas.ts'

function request(topic, speakerId = 'ai1', history = []) {
  return { topic: topic.title, topicDetails: topic, speakerId, history, persona: personas[speakerId], conversationRules }
}
function reduce(state, type, extras = {}) {
  return debateReducer(state, { type, generationId: state.generationId, timestamp: 1000, ...extras })
}

test('30 original practice topics cover all eight fields with balanced counts and prepared notes', () => {
  assert.equal(practiceTopics.length, 30)
  assert.equal(new Set(practiceTopics.map(topic => topic.id)).size, 30)
  assert.equal(new Set(practiceTopics.map(topic => topic.title)).size, 30)
  const counts = new Map()
  for (const topic of practiceTopics) {
    counts.set(topic.category, (counts.get(topic.category) ?? 0) + 1)
    assert.equal(topic.source, 'prepared')
    assert.equal(topic.mockPoints.length, 3)
    assert.ok(topic.mockPoints.every(text => text.trim()))
  }
  assert.equal(counts.size, 8)
  assert.ok([...counts.values()].every(count => count === 3 || count === 4))
})

test('default random mode draws at start; every pool entry can be selected', () => {
  assert.equal(initialTopicSelection.mode, 'random')
  assert.equal(selectionPreview(initialTopicSelection), null)
  for (let i = 0; i < 30; i++) {
    assert.equal(topicForStart(initialTopicSelection, [], () => (i + 0.5) / 30).id, practiceTopics[i].id)
  }
})

test('random draw excludes five recent sessions and the preview, then allows older topics again', () => {
  const recent = practiceTopics.slice(0, 6).map(topic => topic.id)
  const previewId = practiceTopics[6].id
  for (let i = 0; i < 24; i++) {
    const topic = drawTopic(recent, previewId, () => (i + 0.5) / 24)
    assert.ok(!recent.slice(-5).includes(topic.id))
    assert.notEqual(topic.id, previewId)
  }
  assert.equal(drawTopic(recent, previewId, () => 0).id, practiceTopics[0].id)
})

test('rerolled preview is the exact topic used at start; explicit list choice is not random', () => {
  const selected = practiceTopics[16]
  const neverRandom = () => { throw new Error('should not draw') }
  const preview = { ...initialTopicSelection, previewId: selected.id }
  assert.equal(topicForStart(preview, [], neverRandom), selected)
  const list = { ...initialTopicSelection, mode: 'list', selectedId: selected.id }
  assert.equal(topicForStart(list, [selected.id], neverRandom), selected)
  assert.equal(topicForStart({ ...list, selectedId: 'missing' }, []), null)
})

test('custom topics trim input, reject blank/overlong values, and do not acquire prepared scripts', () => {
  assert.equal(customTopic(' \n '), null)
  assert.equal(customTopic('가'.repeat(MAX_TOPIC_LENGTH + 1)), null)
  assert.ok(customTopic('가'.repeat(MAX_TOPIC_LENGTH)))
  const selection = { ...initialTopicSelection, mode: 'custom', customText: '  행복을 수치로 평가할 수 있는가?  ' }
  const topic = topicForStart(selection, [])
  assert.equal(topic.title, '행복을 수치로 평가할 수 있는가?')
  assert.equal(topic.source, 'custom')
  assert.equal(topic.mockPoints, undefined)
  assert.equal(topicForStart({ ...selection, customText: ' ' }, []), null)
})

test('new session resets active debate but preserves prior topic and original records', () => {
  let state = reduce(initialState, 'START', { topic: practiceTopics[16] })
  state = reduce(state, 'AI_READY', { text: '환경 전환의 비용을 살펴보겠습니다.' })
  state = reduce(state, 'USER_START')
  state = reduce(state, 'DRAFT', { text: '전환 비용을 나누어 부담하면 좋겠습니다.' })
  state = reduce(state, 'USER_FINISH')
  state = reduce(state, 'WAIT_SETTING', { seconds: 50 })
  state = reduce(state, 'MODE', { mode: 'practice' })
  state = reduce(state, 'END', { timestamp: 2000 })
  const oldHistory = state.history
  const oldGeneration = state.generationId
  state = reduce(state, 'START', { topic: practiceTopics[25], timestamp: 3000 })
  assert.equal(state.history, oldHistory)
  assert.equal(state.sessions.length, 2)
  assert.equal(state.sessions[0].topic.id, practiceTopics[16].id)
  assert.equal(state.sessions[0].endedAt, 2000)
  assert.equal(state.sessions[1].topic.id, practiceTopics[25].id)
  assert.equal(state.topic.id, practiceTopics[25].id)
  assert.equal(state.pending.topic, practiceTopics[25].title)
  assert.deepEqual(state.pending.history, [])
  assert.ok(state.generationId > oldGeneration)
  assert.equal(state.waitUntil, null)
  assert.equal(state.waitSeconds, 50)
  assert.equal(state.mode, 'practice')
  assert.equal(state.draft, '')
  assert.equal(elapsedSeconds(state, 3000), 0)
  for (const id of ['user', 'ai1', 'ai2', 'ai3']) assert.equal(participantView(state, id).message, undefined)
  state = reduce(state, 'AI_READY', { text: '지식 공유에 관한 의견입니다.' })
  assert.equal(state.history.at(-1).sessionId, 2)
  assert.equal(state.history.at(-1).replyToId, undefined)
})

test('topic is locked while active or paused; even zero-message sessions retain their topic', () => {
  let state = reduce(initialState, 'START', { topic: practiceTopics[0] })
  assert.equal(reduce(state, 'START', { topic: practiceTopics[1] }), state)
  state = reduce(state, 'PAUSE')
  assert.equal(reduce(state, 'START', { topic: practiceTopics[1] }), state)
  state = reduce(state, 'END')
  assert.equal(state.history.length, 0)
  assert.equal(state.sessions[0].topic.id, practiceTopics[0].id)
  const invalid = { id: 'custom:', title: ' ', source: 'custom', category: '직접 입력' }
  assert.equal(reduce(state, 'START', { topic: invalid }), state)
})

test('all prepared topics use their own notes, not the old AI-decision script', () => {
  for (const topic of practiceTopics.filter(topic => topic.id !== decisionTopic.id)) {
    for (const [index, id] of ['ai1', 'ai2', 'ai3'].entries()) {
      const reply = createMockReply(request(topic, id))
      assert.ok(reply.includes(topic.title))
      assert.ok(reply.includes(topic.mockPoints[index]))
      assert.match(reply, /미리 작성한 예시 논점/)
    }
  }
})

test('custom mock stays generic, quotes actual input, and never routes keywords to the old script', () => {
  const topic = customTopic('여가를 의무적으로 가져야 하는가?')
  const previous = { speakerId: 'user', isUser: true, text: 'AI의 정확도와 책임이라는 표현도 비교해 보고 싶어요.' }
  for (const id of ['ai1', 'ai2', 'ai3']) {
    const reply = createMockReply(request(topic, id, [previous]))
    assert.ok(reply.includes(topic.title))
    assert.ok(reply.includes(previous.text))
    assert.match(reply, /범용 연습 질문/)
    assert.ok(!reply.includes('학습에 쓰이지 않은'))
    assert.ok(!reply.includes('AI 판단을 거부할'))
  }
})

test('changing topics rejects old AI promise, old wait and late voice completion', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
  const requests = []
  const provider = { generateReply(request, signal) {
    return new Promise(resolve => requests.push({ request, signal, resolve }))
  } }
  let state = initialState
  let cancel = () => {}
  function dispatch(action) {
    const next = debateReducer(state, action)
    if (next === state) return
    state = next
    cancel()
    cancel = scheduleTurn(state, dispatch, provider)
  }
  const act = (type, extras = {}) => dispatch({ type, generationId: state.generationId, timestamp: Date.now(), ...extras })
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
  t.after(() => cancel())
  act('START', { topic: practiceTopics[0] })
  await flush()
  const oldGeneration = state.generationId
  act('END')
  act('START', { topic: practiceTopics[16] })
  await flush()
  assert.equal(requests[0].signal.aborted, true)
  assert.equal(requests[1].request.topic, practiceTopics[16].title)
  requests[0].resolve({ text: 'OLD TOPIC RESPONSE' })
  act('WAIT_ELAPSED', { generationId: oldGeneration })
  act('VOICE_FINISH', { generationId: oldGeneration, text: 'OLD VOICE' })
  requests[1].resolve({ text: createMockReply(requests[1].request) })
  await flush()
  t.mock.timers.tick(4999)
  await flush()
  assert.equal(state.history.length, 0)
  t.mock.timers.tick(1)
  await flush()
  assert.equal(state.history.length, 1)
  assert.equal(state.history[0].sessionId, 2)
  assert.ok(state.history[0].text.includes(practiceTopics[16].title))
  assert.ok(!state.history[0].text.includes('OLD'))
})
