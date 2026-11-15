import test from 'node:test'
import assert from 'node:assert/strict'
import { userReplyTarget } from '../src/logic/userReplyTarget.ts'
import { selectNextSpeaker, initialState, debateReducer } from '../src/logic/debate.ts'
import { aiIds } from '../src/data/mockDebate.ts'
import { buildContext, buildResponsesInput, validateRequest } from '../server/dialogue.mjs'

const topic = '친환경 소비를 늘릴 책임은 소비자와 기업 중 누구에게 더 클까?'
const m = (n, speakerId, text) => ({ id: `m${n}`, turnId: n, speakerId, text, isUser: speakerId === 'user',
  sessionId: 1, source: speakerId === 'user' ? 'text' : 'real', timestamp: n * 1000 })
const claims = [m(1, 'ai1', '기업이 생산 방식을 바꿀 수 있으니 기업의 책임이 더 큽니다.'),
  m(2, 'ai2', '소비자의 선택권을 보장해야 합니다. 가격 정보를 비교할 수 있어야 해요.'),
  m(3, 'ai3', '납품 계약부터 나눠 바꾸면 작은 업체도 참여할 수 있겠습니다.')]
const memory = history => ({ version: 1, topic, throughId: history.at(-1).id,
  currentIssue: { key: 'responsibility', question: '전환 비용은 누가 부담하나요?', status: 'open', sourceIds: [] },
  positions: [], coveredArguments: [], openObjections: [], nextIssues: [] })
const contribution = (message, values) => ({ messageId: message.id, speakerId: message.speakerId,
  targetIds: [], purpose: 'establish-position', argumentKey: '생산 설비', point: '생산설비와 전환투자를 기업이 맡아야 합니다.',
  advance: null, answeredObjectionIds: [], followUpFor: null, ...values })
// Previous production policy, kept here only to make before/after routing explicit.
function previousChoice(history) {
  const messages = history.filter(m => !m.isUser), last = messages.at(-1)?.speakerId
  const count = id => messages.filter(m => m.speakerId === id).length
  const offset = Math.floor(messages.length / 3) % 3
  return [...aiIds.slice(offset), ...aiIds.slice(0, offset)].filter(id => id !== last)
    .reduce((best, id) => count(id) < count(best) ? id : best)
}

test('direct question/challenge returns the floor to the author, instead of always excluding the last AI', () => {
  for (const text of ['그런데 기업 부담이 크면 어떻게 하죠?', '그럼 어떻게 해야 하죠?', '그 주장에는 동의하지 않습니다.', '왜요?']) {
    const history = [claims[0], m(2, 'user', text)]
    assert.equal(previousChoice(history), 'ai2')
    assert.equal(selectNextSpeaker(history), 'ai1')
    assert.deepEqual(userReplyTarget(history), { speakerId: 'ai1', reason: 'previous-claim', userMessageId: 'm2', claimMessageId: 'm1' })
  }
})

test('explicit name, honorific and AI number can target someone other than the last speaker', () => {
  for (const name of ['이서연님', '서연 씨', 'AI 2', 'AI2']) {
    const history = [...claims, m(4, 'user', `${name}, 소비자에게 책임을 두는 이유를 설명해 주세요.`)]
    assert.equal(selectNextSpeaker(history), 'ai2')
    assert.equal(userReplyTarget(history).reason, 'named-question')
    assert.equal(userReplyTarget(history).claimMessageId, 'm2')
  }
  assert.equal(userReplyTarget([...claims, m(4, 'user', 'AI20에게 질문합니다.')]), null)
  const addressed = [...claims, m(4, 'ai2', claims[1].text), m(5, 'user', '이서연님, 가격 정보를 어떻게 비교하나요?')]
  assert.notEqual(previousChoice(addressed), 'ai2')
  assert.equal(selectNextSpeaker(addressed), 'ai2')
  assert.equal(userReplyTarget(addressed).claimMessageId, 'm4')
})

test('group questions, multiple names and vague comments retain the existing balanced policy', () => {
  for (const text of ['다른 분들은 어떻게 생각하세요?', '김지훈님 말씀은 들었습니다. 다른 분들은 어떻게 생각하세요?',
    '이서연님과 박민수님은 어떻게 생각하세요?', '세 분의 의견이 궁금합니다.', '그렇군요.', '어떻게 생각하세요?',
    '기업의 생산 방식은 모두 어떻게 생각하세요?', '그런데 주말 수업을 늘리면 어떻게 되나요?']) {
    const history = [...claims, m(4, 'user', text)]
    assert.equal(userReplyTarget(history), null, text)
    assert.equal(selectNextSpeaker(history), previousChoice(history), text)
  }
  const history = [...claims, m(4, 'user', '이서연님, 다른 사람의 선택권을 제한해도 되나요?')]
  assert.equal(userReplyTarget(history).reason, 'named-question')
})

test('independent new claims use distinct relevant sources; shared or weak terms do not force a match', () => {
  const history = [...claims, m(4, 'user', '저는 기업의 생산 방식을 먼저 바꿔야 한다고 봅니다.')]
  assert.equal(previousChoice(history), 'ai2')
  assert.equal(selectNextSpeaker(history), 'ai1')
  assert.equal(userReplyTarget(history).reason, 'related-claim')
  const same = [m(1, 'ai1', '기업의 생산 방식이 중요합니다.'), m(2, 'ai2', '기업의 생산 방식이 중요해요.'),
    m(3, 'user', '기업의 생산 방식을 바꿔야 합니다.')]
  assert.equal(userReplyTarget(same), null)
  assert.equal(userReplyTarget([...claims, m(4, 'user', '전혀 새로운 환경 교육을 제안합니다.')]), null)
})

test('accepted contribution/position references can identify relevance; absent or wrong-speaker references cannot', () => {
  const history = [...claims, m(4, 'user', '생산설비와 전환투자는 기업이 맡아야 합니다.')], state = memory(history)
  const item = contribution(claims[0])
  assert.equal(selectNextSpeaker(history, state, [item]), 'ai1')
  const ghost = { ...item, messageId: 'cancelled', speakerId: 'ai3' }
  assert.equal(userReplyTarget(history, state, [ghost]), null)
  assert.equal(userReplyTarget(history, state, [{ ...item, speakerId: 'ai2' }]), null)
  state.positions = [{ speakerId: 'ai1', claim: item.point, reason: '설비를 고를 권한이 있습니다.', sourceIds: ['m1'] }]
  assert.equal(selectNextSpeaker(history, state), 'ai1')
})

test('priority is consumed by the next accepted AI turn; repeated questions cannot produce three consecutive AI turns by one person', () => {
  const history = [claims[0], m(2, 'user', '그럼 어떻게 해야 하죠?')]
  assert.equal(selectNextSpeaker(history), 'ai1')
  history.push(m(3, 'ai1', '설비 전환 비용을 여러 해에 나눠 부담할 수 있습니다.'))
  assert.notEqual(selectNextSpeaker(history), 'ai1')
  history.push(m(4, 'user', '김지훈님, 그 비용은 누가 내나요?'))
  assert.notEqual(selectNextSpeaker(history), 'ai1')
  assert.equal(selectNextSpeaker(history), previousChoice(history))
})

test('AI-only turns retain their original order and discussion/contribution focus', () => {
  const history = [...claims], state = memory(history)
  state.openObjections = [{ sourceId: 'm3', againstId: 'm1', forSpeaker: 'ai1', point: '작은 업체의 납품 부담은 누가 맡나요?' }]
  const ledger = [contribution(claims[2], { followUpFor: 'ai1' })]
  assert.equal(selectNextSpeaker(history, state, ledger), previousChoice(history))
  assert.equal(userReplyTarget(history, state, ledger), null)
  const context = buildContext(validateRequest({ topic, speakerId: 'ai1', history, discussion: state, contributions: ledger }))
  assert.deepEqual(context.turnFocus, { purpose: 'answer-objection', targetId: 'm3' })
  assert.equal(context.userReply, null)
})

test('server receives the selected speaker plus exact question/source, without changing the 2:1 plan or transcript', () => {
  const history = [claims[0], m(2, 'user', '그런데 기업 부담이 크면 어떻게 하죠?')], before = structuredClone(history)
  const speakerId = selectNextSpeaker(history)
  const request = validateRequest({ topic, speakerId, history })
  const payload = buildResponsesInput(request), context = JSON.parse(payload.input)
  assert.equal(context.nextSpeaker, 'ai1')
  assert.equal(context.userReply.isAddressee, true)
  assert.equal(context.userReply.userMessageId, 'm2')
  assert.equal(context.userReply.claimMessageId, 'm1')
  assert.deepEqual(context.turnFocus, { purpose: 'answer-user', targetId: 'm2' })
  assert.equal(context.recentMessages.find(m => m.id === 'm1').text, claims[0].text)
  assert.equal(context.recentMessages.find(m => m.id === 'm2').text, history[1].text)
  const other = buildContext({ ...request, speakerId: 'ai2' })
  assert.deepEqual(context.stancePlan, other.stancePlan)
  assert.equal(other.userReply.isAddressee, false)
  assert.match(payload.instructions, /본인 주장에 대한 질문에 방법·이유·한계 중 물은 내용을 직접 답/)
  assert.deepEqual(history, before)
})

test('old named source remains verbatim beyond the recent-message window; metadata disappears after an AI replies', () => {
  const history = [m(1, 'ai2', '소비자가 선택할 수 있는 가격 정보를 보장해야 합니다.'.repeat(25)),
    ...Array.from({ length: 15 }, (_, i) => m(i + 2, i % 2 ? 'ai1' : 'ai3', '기업의 납품 계약을 나눠야 합니다.')),
    m(17, 'user', '이서연님, 가격 정보를 어떻게 보장하나요?')]
  const context = buildContext(validateRequest({ topic, speakerId: selectNextSpeaker(history), history }))
  assert.equal(context.userReply.claimMessageId, 'm1')
  assert.equal(context.earlierContext.find(m => m.id === 'm1').text, history[0].text)
  history.push(m(18, 'ai2', '구매 전에 가격을 한 화면에서 비교하게 할 수 있습니다.'))
  assert.equal(buildContext(validateRequest({ topic, speakerId: 'ai1', history })).userReply, null)
})

test('real reducer retargets only finalized user input and rejects stale/duplicate/cancelled AI completions', () => {
  const send = (state, type, extra = {}) => debateReducer(state, { type, generationId: state.generationId, timestamp: 1000, ...extra })
  let state = send(initialState, 'START', { topic: { title: topic, source: 'custom' } })
  state = send(state, 'AI_READY', { text: claims[0].text })
  state = send(state, 'NEXT')
  const oldGeneration = state.generationId
  assert.equal(state.pending.speakerId, 'ai2')
  state = send(state, 'USER_START')
  state = send(state, 'DRAFT', { text: '그런데 기업 부담이 크면 어떻게 하죠?' })
  const userGeneration = state.generationId
  state = send(state, 'USER_FINISH')
  assert.equal(state.status, 'aiTyping')
  assert.equal(state.waitUntil, null)
  assert.equal(state.pending.speakerId, 'ai1')
  assert.equal(send(state, 'AI_READY', { generationId: oldGeneration, text: '취소된 다른 AI' }), state)
  assert.equal(send(state, 'VOICE_FINISH', { generationId: userGeneration, text: '중복 사용자 발언' }), state)
  const generation = state.generationId
  state = send(state, 'AI_READY', { text: '기업 규모에 따라 전환 비용을 나눠야 합니다.' })
  assert.equal(state.history.filter(m => m.isUser).length, 1)
  assert.equal(state.history.at(-1).speakerId, 'ai1')
  assert.equal(send(state, 'AI_READY', { generationId: generation, text: '중복 AI 발언' }), state)
  state = send(state, 'NEXT')
  assert.notEqual(state.pending.speakerId, 'ai1')
  const pendingGeneration = state.generationId
  state = send(state, 'END')
  assert.equal(send(state, 'AI_READY', { generationId: pendingGeneration, text: '종료 후 늦은 발언' }), state)
})

test('finalized voice question uses the same route; interim input cannot start an AI or duplicate the turn', () => {
  const send = (state, type, extra = {}) => debateReducer(state, { type, generationId: state.generationId, timestamp: 1000, ...extra })
  let state = send(initialState, 'START', { topic: { title: topic, source: 'custom' } })
  state = send(state, 'AI_READY', { text: claims[0].text })
  state = send(state, 'USER_START')
  const generationId = state.generationId
  state = send(state, 'VOICE_DRAFT', { text: '그럼 어떻게 해야 하죠?' })
  assert.equal(state.pending, null)
  assert.equal(state.history.length, 1)
  state = send(state, 'VOICE_FINISH', { text: '그럼 어떻게 해야 하죠?' })
  assert.equal(state.pending.speakerId, 'ai1')
  assert.equal(state.history.at(-1).source, 'speech')
  assert.equal(send(state, 'VOICE_FINISH', { generationId, text: '그럼 어떻게 해야 하죠?' }), state)
})
