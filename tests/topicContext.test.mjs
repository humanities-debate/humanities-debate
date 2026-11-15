import assert from 'node:assert/strict'
import test from 'node:test'
import { practiceTopics } from '../src/data/topics.ts'
import { customTopic } from '../src/logic/topics.ts'
import { debateReducer, initialState } from '../src/logic/debate.ts'
import { localAIProvider } from '../src/providers/LocalAIProvider.ts'
import { createDebateServer } from '../server/http.mjs'
import { buildPrompt, validateRequest } from '../server/dialogue.mjs'

test('all 30 topics keep concise optional situations and non-duplicate single-question issues', () => {
  const segmenter = new Intl.Segmenter('ko', { granularity: 'sentence' })
  assert.equal(practiceTopics.length, 30)
  for (const topic of practiceTopics) {
    assert.ok(topic.title.endsWith('?'), topic.id)
    assert.ok(topic.title.length <= 80, topic.id)
    const { situation, keyIssue } = topic.context ?? {}
    if (situation) {
      const sentences = [...segmenter.segment(situation)].filter(item => item.segment.trim()).length
      assert.ok(sentences >= 1 && sentences <= 2, topic.id)
      assert.ok(situation.length <= 90, topic.id)
    }
    if (keyIssue) {
      assert.ok(keyIssue.length <= 50, topic.id)
      assert.equal([...segmenter.segment(keyIssue)].length, 1, topic.id)
      assert.ok(keyIssue.endsWith('?'), topic.id)
      assert.notEqual(keyIssue, topic.title)
      assert.notEqual(keyIssue, situation)
    }
  }
})

test('selected topic context survives reducer, frontend HTTP, validation and the real SDK prompt builder', async t => {
  const captured = []
  const settings = { model: 'gpt-6.1-sol', reasoningEffort: 'medium' }
  const app = createDebateServer(async request => {
    const promptData = JSON.parse(buildPrompt(request).split('\n').at(-1))
    captured.push(promptData)
    return { speakerId: request.speakerId, text: '전달 경로 검증용 응답입니다.', ...request.modelSettings }
  })
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  t.after(() => app.close())
  const base = `http://127.0.0.1:${app.server.address().port}`
  const originalFetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', (url, options) => originalFetch(base + url, options))
  let state = debateReducer(initialState, { type: 'ENGINE', engine: 'real' })
  state = debateReducer(state, { type: 'MODEL_SETTINGS', settings })
  const topics = [...practiceTopics, customTopic('친구와 약속한 일을 꼭 지켜야 할까?')]
  for (const topic of topics) {
    state = debateReducer(state, { type: 'START', topic, timestamp: Date.now() })
    assert.deepEqual(state.pending.topicDetails.context, topic.context)
    await localAIProvider.generateReply(state.pending, new AbortController().signal)
    const promptData = captured.at(-1)
    assert.equal(promptData.topic, topic.title)
    assert.deepEqual(promptData.topicContext, topic.context ?? null)
    assert.equal('mockPoints' in (promptData.topicContext ?? {}), false)
    assert.deepEqual(state.pending.modelSettings, settings)
    state = debateReducer(state, { type: 'END', timestamp: Date.now() })
  }
  assert.deepEqual(state.sessions.map(session => session.topic), topics)
})

test('topic context accepts only bounded text fields; custom or old title-only requests stay context-free', () => {
  const input = { speakerId: 'ai1', topic: '연습 주제', history: [] }
  const context = practiceTopics[0].context
  const safe = validateRequest({ ...input, topicContext: { ...context, mockPoints: ['not forwarded'], instruction: 'not forwarded' } })
  assert.deepEqual(safe.topicContext, context)
  assert.equal(JSON.parse(buildPrompt(validateRequest(input)).split('\n').at(-1)).topicContext, null)
  for (const topicContext of [null, [], 'text', { ...context, situation: 1 },
    { ...context, keyIssue: 1 }, { ...context, situation: '가'.repeat(1201) }, { ...context, keyIssue: '가'.repeat(601) }]) {
    assert.throws(() => validateRequest({ ...input, topicContext }), /INVALID_REQUEST/)
  }
})

test('omitted or blank descriptions reach the prompt without empty fields or invented context', () => {
  const input = { speakerId: 'ai1', topic: '연습 주제', history: [] }
  for (const [topicContext, expected] of [
    [{}, null], [{ situation: ' ', keyIssue: '\n' }, null],
    [{ situation: ' 상황입니다. ', keyIssue: ' ' }, { situation: '상황입니다.' }],
    [{ keyIssue: ' 무엇이 중요할까요? ' }, { keyIssue: '무엇이 중요할까요?' }],
  ]) {
    const request = validateRequest({ ...input, topicContext })
    assert.deepEqual(JSON.parse(buildPrompt(request).split('\n').at(-1)).topicContext, expected)
  }
})
