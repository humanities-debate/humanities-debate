import test from 'node:test'
import assert from 'node:assert/strict'
import { parseContribution, parseContributions, validateContributionUse } from '../src/logic/contribution.ts'
import { parseDiscussion, discussionFocus } from '../src/logic/discussion.ts'
import { metadataDiagnostic } from '../src/logic/debateMetadata.ts'
import { initialState, debateReducer, sessionMessages } from '../src/logic/debate.ts'
import { localAIProvider } from '../src/providers/LocalAIProvider.ts'
import { scheduleTurn } from '../src/logic/turnScheduler.ts'
import { validateRequest, validateReply, buildContext } from '../server/dialogue.mjs'

const topic = '건강한 사람도 기억력을 높이는 기술을 써도 될까?'
const m = (n, speakerId = 'ai1') => ({ id: `m${n}`, turnId: n, speakerId, text: `${n}번째 발언`, isUser: speakerId === 'user' })
const memory = history => ({ version: 1, topic, throughId: history.at(-1)?.id ?? null,
  currentIssue: { key: 'access', question: '준비 과정의 격차를 줄일 수 있을까?', status: 'open', sourceIds: [] },
  positions: [], coveredArguments: [], openObjections: [], nextIssues: ['일상에서 쓰지 않을 선택은 어떻게 지킬까?'] })
const contribution = (overrides = {}) => ({ targetIds: [], purpose: 'establish-position', argumentKey: '선택의 자유', point: '사용은 개인이 결정해야 합니다.',
  advance: null, answeredObjectionIds: [], followUpFor: null, ...overrides })
const record = (n, speakerId, overrides = {}) => ({ ...contribution(overrides), messageId: `m${n}`, speakerId })
const start = () => debateReducer(initialState, { type: 'START', topic: { title: topic, source: 'custom' }, timestamp: 1000 })
const send = (state, type, extra = {}) => debateReducer(state, { type, generationId: state.generationId, timestamp: 6000, ...extra })

test('only visible accepted turns commit a contribution once; cancelled, paused, ended and prior-session completions cannot commit', () => {
  let state = start(), first = contribution()
  state = send(state, 'AI_READY', { text: '확정된 의견', contribution: first })
  assert.deepEqual(state.contributions, [{ ...first, messageId: state.history[0].id, speakerId: 'ai1' }])
  assert.equal(Object.hasOwn(state.history[0], 'contribution'), false)
  assert.equal(send(state, 'AI_READY', { text: '중복', contribution: first }), state)
  state = send(state, 'NEXT')
  assert.deepEqual(state.pending.contributions, state.contributions)
  const pendingId = state.generationId
  for (const type of ['USER_START', 'PAUSE', 'END']) {
    const stopped = send(state, type)
    assert.equal(send(stopped, 'AI_READY', { generationId: pendingId, text: '늦은 발언', contribution: first }), stopped)
    assert.equal(stopped.contributions.length, 1)
  }
  const reset = send(send(state, 'END'), 'START', { topic: { title: topic, source: 'custom' } })
  assert.deepEqual(reset.contributions, [])
  assert.equal(send(reset, 'AI_READY', { generationId: pendingId, text: '이전 토론', contribution: first }), reset)
})

test('answers remove only the old reply task, never declare persuasion; genuinely new rebuttals and users take priority', () => {
  const history = [m(1), m(2, 'ai2'), m(3, 'ai3')], state = memory(history)
  state.currentIssue = { ...state.currentIssue, status: 'examined', sourceIds: ['m1', 'm2'] }
  state.openObjections = [{ sourceId: 'm2', againstId: 'm1', forSpeaker: 'ai1', point: '비용 부담은 누가 맡나요?' }]
  const ledger = [record(3, 'ai3', { targetIds: ['m2'], purpose: 'answer-objection', answeredObjectionIds: ['m2'] })]
  assert.equal(discussionFocus(state, 'ai1', history).purpose, 'answer-objection')
  assert.equal(discussionFocus(state, 'ai1', history, ledger).purpose, 'test-disagreement-in-related-case')
  assert.equal(state.currentIssue.status, 'examined')
  ledger[0].followUpFor = 'ai1'
  assert.deepEqual(discussionFocus(state, 'ai1', history, ledger), { purpose: 'counter-rebuttal', targetId: 'm3' })
  state.openObjections.push({ sourceId: 'm3', againstId: 'm2', forSpeaker: 'ai1', point: '공동 부담에도 참여 못 하면요?' })
  assert.deepEqual(discussionFocus(state, 'ai1', history, ledger), { purpose: 'answer-objection', targetId: 'm3' })
  assert.deepEqual(discussionFocus(state, 'ai1', [...history, m(4, 'user')], ledger), { purpose: 'answer-user', targetId: 'm4' })
})

test('a speaker never receives their own old objection as the target; follow-up is closed by a visible direct reply', () => {
  const history = [m(1), m(2, 'ai2'), m(3, 'ai3')], state = memory(history)
  state.openObjections = [{ sourceId: 'm1', againstId: null, forSpeaker: 'ai2', point: '내가 했던 반론' }]
  const ledger = [record(2, 'ai2', { followUpFor: 'ai1' })]
  assert.deepEqual(discussionFocus(state, 'ai1', history, ledger), { purpose: 'counter-rebuttal', targetId: 'm2' })
  ledger.push(record(3, 'ai3', { targetIds: ['m2'], answeredObjectionIds: ['m2'], purpose: 'counter-rebuttal' }))
  assert.equal(discussionFocus(state, 'ai1', history, ledger).purpose, 'deepen-current-issue')
})

test('teammate reason reuse requires progress, while answering a new objection may legitimately use an existing reason', () => {
  const ledger = [record(2, 'ai1', { targetIds: ['m1'], answeredObjectionIds: ['m1'], purpose: 'answer-objection' })]
  assert.throws(() => validateContributionUse(contribution(), 'ai3', ledger, ['ai1']), /INVALID_CONTRIBUTION/)
  assert.doesNotThrow(() => validateContributionUse(contribution({ advance: '사용하지 않는 사람에게도 별도 선택권을 주는 조건' }), 'ai3', ledger, ['ai1']))
  assert.doesNotThrow(() => validateContributionUse(contribution({ purpose: 'counter-rebuttal', targetIds: ['m3'], answeredObjectionIds: ['m3'] }), 'ai3', ledger, ['ai1']))
  assert.doesNotThrow(() => validateContributionUse(contribution(), 'ai2', ledger, []))
})

test('execution plan mismatch cannot masquerade as accepted progress; the valid utterance and previous memory survive', () => {
  const history = [m(1, 'user')], request = validateRequest({ topic, speakerId: 'ai1', history, contributions: [] })
  const diagnostics = []
  const bad = contribution({ targetIds: ['m1'], purpose: 'deepen-current-issue' })
  const text = '이 기술을 쓰지 않을 선택도 지켜야 합니다.'
  const reply = validateReply(JSON.stringify({ speakerId: 'ai1', text, contribution: bad }), request, d => diagnostics.push(d))
  assert.equal(reply.text, text)
  assert.equal(reply.contribution, undefined)
  assert.deepEqual(diagnostics, [{ code: 'INVALID_CONTRIBUTION', reason: 'PLAN_MISMATCH', field: 'contribution.purpose' }])
  let state = start()
  state = send(state, 'USER_START')
  state = send(state, 'DRAFT', { text: '사용자 최종 원문' })
  state = send(state, 'USER_FINISH')
  const before = state.history.map(m => m.text)
  const invalid = memory(state.pending.history); invalid.throughId = 'invented'
  state = send(state, 'AI_READY', { text, contribution: bad, discussion: invalid })
  assert.deepEqual(state.history.map(m => m.text), [...before, text])
  assert.deepEqual(state.contributions, [])
  assert.equal(state.discussion, null)
})

test('ledger provenance rejects invented commits, wrong speakers, reversed reply edges, duplicate/out-of-order commits', () => {
  const history = [m(1, 'user'), m(2), m(3, 'ai2')]
  const good = record(2, 'ai1', { targetIds: ['m1'], answeredObjectionIds: ['m1'], purpose: 'answer-user' })
  assert.deepEqual(parseContributions([good], history), [good])
  for (const bad of [{ ...good, messageId: 'missing' }, { ...good, speakerId: 'ai2' }, { ...good, targetIds: ['m3'] }]) {
    assert.throws(() => parseContributions([bad], history), /INVALID_CONTRIBUTION/)
    assert.throws(() => validateRequest({ topic, speakerId: 'ai1', history, contributions: [bad] }), /INVALID_REQUEST/)
  }
  assert.throws(() => parseContributions([good, good], history), /INVALID_CONTRIBUTION/)
  assert.throws(() => parseContributions([record(3, 'ai2'), good], history), /INVALID_CONTRIBUTION/)
  assert.throws(() => parseContribution(contribution({ targetIds: ['missing'] }), history), /INVALID_CONTRIBUTION/)
})

test('field diagnostics distinguish reference/time/evidence/stale/size failures and never include private input values', () => {
  const history = [m(1, 'user'), m(2), m(3, 'ai2')], state = memory(history)
  const cases = [
    [v => v.openObjections = [{ sourceId: 'm1', againstId: 'm2', forSpeaker: 'ai1', point: '비공개 내용' }], 'TIME_ORDER', 'discussion.openObjections.againstId'],
    [v => v.throughId = 'private-secret-reference', 'UNKNOWN_REFERENCE', 'discussion.throughId'],
    [v => v.throughId = 'm1', 'STALE_SNAPSHOT', 'discussion.throughId'],
    [v => v.currentIssue = { ...v.currentIssue, status: 'examined', sourceIds: ['m2'] }, 'PARTICIPANT_EVIDENCE', 'discussion.currentIssue.sourceIds'],
    [v => v.nextIssues = Array(4).fill('비공개 내용'), 'COUNT', 'discussion.nextIssues'],
  ]
  for (const [mutate, reason, field] of cases) {
    const bad = structuredClone(state); mutate(bad)
    assert.throws(() => parseDiscussion(bad, topic, history, true), error => {
      assert.deepEqual(metadataDiagnostic(error), { code: 'INVALID_DISCUSSION', reason, field })
      assert.ok(!JSON.stringify(metadataDiagnostic(error)).includes('private-secret'))
      return true
    })
  }
  state.currentIssue = { ...state.currentIssue, status: 'examined', sourceIds: ['m1', 'm2', 'm3'] }
  assert.equal(parseDiscussion(state, topic, history, true).currentIssue.status, 'examined')
})

test('validated contribution survives transport and typing delay; the following real request contains the actual commit IDs', async t => {
  let state = start(), posted
  state = send(state, 'USER_START')
  state = send(state, 'DRAFT', { text: '사용하지 않을 자유도 있어야 합니다.' })
  state = send(state, 'USER_FINISH')
  const item = contribution({ targetIds: [state.history.at(-1).id], answeredObjectionIds: [state.history.at(-1).id], purpose: 'answer-user' })
  state.pending.modelSettings = { model: 'gpt-6-luna', reasoningEffort: 'medium' }
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === '/api/session') return new Response(JSON.stringify({ token: 'local-test-capability' }))
    posted = JSON.parse(options.body)
    return new Response(JSON.stringify({ id: posted.id, speakerId: posted.request.speakerId, text: '공통 평가를 따로 마련할 수 있습니다.', contribution: item, ...posted.request.modelSettings }))
  })
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
  const actions = [], cancel = scheduleTurn(state, action => actions.push(action), localAIProvider)
  t.after(cancel)
  for (let i = 0; i < 30; i++) await Promise.resolve()
  assert.deepEqual(posted.request.contributions, [])
  assert.deepEqual(state.contributions, [])
  t.mock.timers.tick(5000)
  for (let i = 0; i < 30; i++) await Promise.resolve()
  state = debateReducer(state, actions[0])
  assert.equal(state.contributions.length, 1)
  assert.equal(state.contributions[0].messageId, state.history.at(-1).id)
  state = send(state, 'NEXT')
  const input = validateRequest({ ...state.pending, history: sessionMessages(state) })
  const context = buildContext(input)
  assert.deepEqual(context.contributions, state.contributions)
  assert.equal(context.turnFocus.purpose, 'establish-position')
})

test('scheduler cancellation after response arrival but before display prevents both transcript and contribution commits', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
  const state = start(), actions = []
  const cancel = scheduleTurn(state, action => actions.push(action), { generateReply: async () => ({ text: '취소될 의견', contribution: contribution() }) })
  for (let i = 0; i < 10; i++) await Promise.resolve()
  cancel(); t.mock.timers.tick(6000)
  for (let i = 0; i < 10; i++) await Promise.resolve()
  assert.deepEqual(actions, [])
  assert.deepEqual(state.contributions, [])
  assert.deepEqual(state.history, [])
})

test('invalid discussion does not discard an independently valid contribution or the exact accepted text', () => {
  const request = validateRequest({ topic, speakerId: 'ai1', history: [], contributions: [] })
  const item = contribution(), bad = memory([]); bad.throughId = 'missing'
  const text = '내가 실제로 말한 원문은 그대로 남습니다.'
  const diagnostics = []
  const reply = validateReply(JSON.stringify({ speakerId: 'ai1', text, discussion: bad, contribution: item }), request, d => diagnostics.push(d))
  assert.deepEqual(reply.contribution, item)
  assert.equal(reply.discussionRejected, true)
  const state = send(start(), 'AI_READY', reply)
  assert.equal(state.history[0].text, text)
  assert.equal(state.contributions.length, 1)
  assert.deepEqual(diagnostics, [{ code: 'INVALID_DISCUSSION', reason: 'UNKNOWN_REFERENCE', field: 'discussion.throughId' }])
})

test('full ledger still controls priority when prompt metadata is bounded; selected old targets stay verbatim', () => {
  const history = [m(1, 'user'), ...Array.from({ length: 40 }, (_, i) => m(i + 2, i % 2 ? 'ai2' : 'ai1'))]
  history[1].text = '생략되면 안 되는 과거 반론 원문'.repeat(40)
  const ledger = history.slice(1).map((message, i) => record(message.turnId, message.speakerId, i === 0 ? { targetIds: ['m1'], purpose: 'answer-user', answeredObjectionIds: ['m1'] } : {}))
  const state = memory(history)
  state.openObjections = [{ sourceId: 'm1', againstId: null, forSpeaker: 'ai2', point: '이미 답변한 질문' },
    { sourceId: 'm2', againstId: 'm1', forSpeaker: 'ai2', point: '아직 답하지 않은 반론' }]
  const context = buildContext(validateRequest({ topic, speakerId: 'ai2', history, discussion: state, contributions: ledger }))
  assert.equal(context.contributions.length, 24)
  assert.equal(context.turnFocus.targetId, 'm2')
  assert.equal(context.earlierContext.find(m => m.id === 'm2').text, history[1].text)
  assert.equal(ledger.length, 40)
})
