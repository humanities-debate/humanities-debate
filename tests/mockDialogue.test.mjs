import assert from 'node:assert/strict'
import test from 'node:test'
import { personas, conversationRules } from '../src/data/personas.ts'
import { createMockReply } from '../src/providers/MockAIProvider.ts'
import { debateReducer, initialState } from '../src/logic/debate.ts'
import { topic } from '../src/data/mockDebate.ts'
import { decisionTopic } from '../src/data/topics.ts'

function message(speakerId, text) {
  return { id: 'example', speakerId, text, isUser: speakerId === 'user', source: speakerId === 'user' ? 'text' : 'mock', turnId: 1, timestamp: 1, sessionId: 1 }
}
function request(speakerId, history) {
  return { speakerId, history, topic, topicDetails: decisionTopic, persona: personas[speakerId], conversationRules }
}

test('provider request carries reusable persona and shared conversation rules', () => {
  let state = debateReducer(initialState, { type: 'START', topic: decisionTopic, timestamp: 1 })
  const seen = new Set()
  for (let i = 0; i < 3; i++) {
    const pending = state.pending
    seen.add(pending.speakerId)
    assert.equal(pending.persona, personas[pending.speakerId])
    assert.equal(pending.conversationRules, conversationRules)
    assert.ok(pending.persona.rules.length)
    state = debateReducer(state, { type: 'AI_READY', text: createMockReply(pending), generationId: state.generationId, timestamp: 2 })
    state = debateReducer(state, { type: 'NEXT', generationId: state.generationId, timestamp: 3 })
  }
  assert.equal(seen.size, 3)
})

test('same user input produces distinct formal, counterargument and mediating mock styles', () => {
  const input = message('user', 'AI의 정확도가 높다면 결정권을 넓혀도 될까요?')
  const replies = ['ai1', 'ai2', 'ai3'].map(id => createMockReply(request(id, [input])))
  assert.equal(new Set(replies).size, 3)
  assert.match(replies[0], /근거.*좋겠습니다/)
  assert.match(replies[0], /질문에 답을 드리면/)
  assert.match(replies[1], /^근데 /)
  assert.match(replies[1], /어렵지 않을까요/)
  assert.match(replies[2], /^아, /)
  assert.match(replies[2], /방식은 어떨까요/)
  for (const reply of replies) assert.ok(reply.includes(input.text))
})

test('each persona varies introductions across consecutive completed turns', () => {
  for (const id of ['ai1', 'ai2', 'ai3']) {
    const history = []
    const openings = []
    for (let i = 0; i < 3; i++) {
      const reply = createMockReply(request(id, [...history, message('user', '공정한 결정이어야 해요.')]))
      openings.push(reply.slice(0, reply.indexOf('집단') >= 0 ? reply.indexOf('집단') : reply.length))
      history.push(message(id, reply))
    }
    assert.equal(new Set(openings).size, 3)
  }
})

test('mock response body changes with the user point, beyond repeating the quote', () => {
  for (const id of ['ai1', 'ai2', 'ai3']) {
    const fairness = createMockReply(request(id, [message('user', '소수 집단의 차별이 걱정돼요.')])).replace(/“[^”]*”/g, '')
    const accuracy = createMockReply(request(id, [message('user', '정확도가 높아도 오류가 있겠죠.')])).replace(/“[^”]*”/g, '')
    assert.notEqual(fairness, accuracy)
    assert.match(fairness, /집단/)
    assert.match(accuracy, /검증|피해|검토/)
  }
})

test('AI replies address the preceding participant and its current point without recursive quotes', () => {
  const history = [message('ai1', '“이전 인용문”이라는 의견을 들었습니다. 정확도를 어떻게 검증하면 좋겠습니까?')]
  const reply = createMockReply(request('ai2', history))
  assert.match(reply, /김지훈 님/)
  assert.match(reply, /정확도를 어떻게 검증하면 좋겠습니까/)
  assert.match(reply, /그 질문에는/)
  assert.ok(!reply.includes('이전 인용문'))
})

test('mediating persona can object; counterargument persona acknowledges useful points', () => {
  const mediator = createMockReply(request('ai3', [message('ai3', '앞선 발언'), message('user', '다수에게 공정하면 충분해요.')]))
  assert.match(mediator, /소수의 피해를 넘길 수는 없을/)
  const counter = createMockReply(request('ai2', [message('user', '정확도가 높아요.')]))
  assert.match(counter, /인정해요/)
  assert.match(counter, /어렵지 않을까요/)
})

test('quoted user text is literal and long input is bounded', () => {
  const literal = '$& $` $\' {name}'
  assert.ok(createMockReply(request('ai1', [message('user', literal)])).includes(literal))
  const reply = createMockReply(request('ai1', [message('user', '가'.repeat(4000))]))
  assert.ok(reply.length < 500)
  assert.ok(reply.includes('…'))
})
