import test from 'node:test'
import assert from 'node:assert/strict'
import { practiceTopics } from '../src/data/topics.ts'
import { stancePlan } from '../server/stances.mjs'
import { createStanceApproval, isOpening, stanceReviewSchema, stanceReviewInput, validateStanceReview } from '../server/stanceApproval.mjs'
import { buildContext, replySchema, validateRequest } from '../server/dialogue.mjs'
import { createSIWCRuntime } from '../server/siwcRuntime.mjs'
import { localAIProvider } from '../src/providers/LocalAIProvider.ts'
import { initialState, debateReducer } from '../src/logic/debate.ts'
import { scheduleTurn } from '../src/logic/turnScheduler.ts'

const topic = practiceTopics.find(t => t.id === 'social-tradition')
const settings = { model: 'gpt-6-luna', reasoningEffort: 'medium', preset: 'debate-standard' }
const models = [{ model: settings.model, reasoningEfforts: ['medium'] }]
const m = (id, speakerId, text) => ({ id, turnId: Number(id.slice(1)), speakerId, text, isUser: speakerId === 'user' })
const request = (speakerId, history = []) => validateRequest({ topic: topic.title, topicContext: topic.context, speakerId, history, modelSettings: settings })
const opponent = Object.keys(stancePlan(topic.title).sides).find(id => stancePlan(topic.title).sides[id] === 'B')
const review = (position, evidence, contradicts = false) => JSON.stringify({ position, evidence, contradicts })

test('all 30 prepared titles have fixed concrete opposing propositions before any generated speech', async () => {
  assert.equal(practiceTopics.length, 30)
  const guard = createStanceApproval()
  for (const t of practiceTopics) {
    const choices = stancePlan(t.title).choices
    assert.ok(choices.A.length >= 8 && choices.B.length >= 8 && choices.A !== choices.B)
    for (const speakerId of ['ai1','ai2','ai3']) {
      const input = validateRequest({ topic: t.title, speakerId, history: [] })
      assert.equal(await guard.prepare(input, () => { throw new Error('unnecessary plan request') }), input)
      const context = buildContext(input)
      assert.equal(context.participants.find(p => p.id === speakerId).initialChoice, choices[context.stancePlan.sides[speakerId]])
    }
  }
})

test('opening review is blind to assignment and checks the actual unchanged utterance with original evidence', () => {
  const input = request(opponent), text = '공동체 유지를 위해 일정 수준의 행사 참여 의무를 부과할 수 있다고 봅니다.'
  const payload = stanceReviewInput(input, text), data = JSON.parse(payload.input)
  assert.equal(data.text, text); assert.deepEqual(data.choices, stancePlan(topic.title).choices)
  assert.ok(!Object.hasOwn(data, 'speakerId') && !Object.hasOwn(data, 'expectedSide'))
  assert.deepEqual(payload.outputSchema, stanceReviewSchema)
  assert.doesNotThrow(() => validateStanceReview(review('B', text), input, text))
  for (const raw of [review('A', text), review('unclear', ''), review('B', '발언에 없는 참여 의무 주장'), review('B', text, true), '{}', '{broken']) {
    assert.throws(() => validateStanceReview(raw, input, text), /STANCE_MISMATCH|STANCE_UNVERIFIED/)
  }
})

test('same-side concession disguised as opposition never passes the runtime or creates a fallback speech', async () => {
  const text = '저도 참여하지 않을 자유는 인정해야 한다고 생각합니다. 다만 공동체도 중요합니다.'
  let generations = 0, reviews = 0
  const runtime = createSIWCRuntime({ models, accountScope: 'test', getAccountScope: async () => 'test', client: { async streamResponse(options) {
    if (options.outputSchema === replySchema) { generations++; return { text: JSON.stringify({ speakerId: opponent, text }) } }
    assert.deepEqual(options.outputSchema, stanceReviewSchema); reviews++
    assert.equal(JSON.parse(options.input).text, text)
    return { text: review('A', text.slice(0, 32)) }
  } } })
  await assert.rejects(runtime.generate(request(opponent), new AbortController().signal), /STANCE_MISMATCH/)
  assert.equal(generations, 1); assert.equal(reviews, 1)
})

test('each candidate is checked on their first accepted speech only; later reasoned changes remain possible', async () => {
  const input = request(opponent), text = '공동체 유지를 위해 일정한 참여 의무를 둘 수 있다고 봅니다.'
  const guard = createStanceApproval(); let checks = 0
  await guard.approve(input, { text }, async () => { checks++; return review('B', text) })
  const later = request(opponent, [m('m1', opponent, text)])
  assert.equal(isOpening(later), false)
  await guard.approve(later, { text: '그 근거를 듣고 보니 이번 경우는 자율에 맡기는 편이 낫겠어요.' }, async () => { throw new Error('unnecessary review') })
  assert.equal(checks, 1)
  // Another speaker has not yet presented an initial position.
  assert.equal(isOpening(request(opponent === 'ai1' ? 'ai2' : 'ai1', [m('m1', opponent, text)])), true)
})

test('custom topics resolve one shared plan without trusting browser-supplied plans or copying scripts', async () => {
  const input = validateRequest({ topic: '실험적인 제안을 채택해야 할까?', speakerId: 'ai1', history: [], stanceChoices: { A: 'evil', B: 'evil' } })
  assert.ok(!Object.hasOwn(input, 'stanceChoices'))
  const guard = createStanceApproval(); let calls = 0
  const complete = async () => { calls++; return JSON.stringify({ A: '실험적인 제안을 도입해야 한다', B: '실험적인 제안의 도입을 보류해야 한다', opposed: true }) }
  const one = await guard.prepare(input, complete), two = await guard.prepare({ ...input, speakerId: 'ai2' }, complete)
  assert.deepEqual(one.stanceChoices, two.stanceChoices); assert.equal(calls, 1)
  const separate = createStanceApproval()
  await separate.prepare(input, complete); assert.equal(calls, 2)
  await assert.rejects(createStanceApproval().prepare(input, async () => JSON.stringify({ A: '같은 선택을 한다', B: '같은 선택을 한다', opposed: true })), /STANCE_UNVERIFIED/)
})

test('internal labels are rejected without a check request; real user A/B alternatives stay allowed', async () => {
  const input = request(opponent), guard = createStanceApproval()
  await assert.rejects(guard.approve(input, { text: '저도 A 쪽입니다. 공동체를 지켜야 합니다.' }, async () => { throw new Error('unnecessary') }), /INTERNAL_STANCE_LABEL/)
  const later = request(opponent, [m('m1', opponent, '참여 의무를 둘 수 있다고 봅니다.')])
  await assert.rejects(guard.approve(later, { text: '저는 B 쪽을 유지합니다.' }, async () => { throw new Error('unnecessary') }), /INTERNAL_STANCE_LABEL/)
  const user = m('m1', 'user', 'A안은 참여 의무, B안은 자율입니다.')
  const text = 'A안인 제한적인 참여 의무를 두자는 입장입니다.'
  await guard.approve(request(opponent, [user]), { text }, async () => review('B', text))
})

test('abort and account change during the review discard a late approval', async () => {
  for (const mode of ['abort', 'account']) {
    let account = 'a', finish, began
    const started = new Promise(resolve => { began = resolve }), controller = new AbortController()
    const text = '공동체 유지를 위해 참여 의무를 둘 수 있습니다.'
    const runtime = createSIWCRuntime({ models, accountScope: 'a', getAccountScope: async () => account, client: { async streamResponse(options) {
      if (options.outputSchema === replySchema) return { text: JSON.stringify({ speakerId: opponent, text }) }
      began(); return new Promise(resolve => { finish = () => resolve({ text: review('B', text) }) })
    } } })
    const pending = runtime.generate(request(opponent), controller.signal), rejection = assert.rejects(pending, /CANCELLED/)
    await started
    if (mode === 'abort') controller.abort(); else account = 'b'
    finish(); await rejection
  }
})

test('rejected opening pauses via the existing error path without a visible speech, contribution or record', async () => {
  let state = debateReducer(initialState, { type: 'START', topic, timestamp: 1000 })
  let finished
  const done = new Promise(resolve => { finished = resolve })
  const run = scheduleTurn(state, action => { state = debateReducer(state, action); finished() }, { async generateReply() { throw new Error('fixture') } })
  await done; run()
  assert.equal(state.status, 'paused'); assert.equal(state.history.length, 0); assert.equal(state.contributions.length, 0)
  const generationId = state.generationId
  assert.equal(debateReducer(state, { type: 'AI_READY', generationId: generationId - 1, text: '늦은 잘못된 응답', timestamp: 2000 }), state)
})

test('UI exposes a safe specific opening failure and keeps the transcript out of the error', async t => {
  t.mock.method(globalThis, 'fetch', async url => new Response(JSON.stringify(url === '/api/session' ? { token: 'local-test-capability' } : { error: 'STANCE_MISMATCH' }), { status: url === '/api/session' ? 200 : 503 }))
  await assert.rejects(localAIProvider.generateReply({ ...request(opponent), modelSettings: settings }, new AbortController().signal), /첫 발언.*보류/)
})
