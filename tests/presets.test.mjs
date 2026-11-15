import assert from 'node:assert/strict'
import test from 'node:test'
import { aiPresets, presetSettings, presetMatches, defaultPreset, settingsAvailable } from '../src/config/aiPresets.ts'
import { validateModelSettings } from '../server/modelCatalog.mjs'
import { debateReducer, initialState } from '../src/logic/debate.ts'
import { decisionTopic } from '../src/data/topics.ts'
import { buildPrompt, validateRequest } from '../server/dialogue.mjs'
import { buildFeedbackPrompt, feedbackRoleInstruction, validateFeedbackReply } from '../server/feedback.mjs'
import { completedRecord, parseRecord } from '../src/records/record.ts'
import { parseFeedback, scoreSummary } from '../src/records/feedback.ts'
import { createLocalRecordRepository } from '../src/records/repository.ts'
import { createRecordLibrary } from '../src/records/library.ts'
import { createDebateServer } from '../server/http.mjs'
import { localAIProvider } from '../src/providers/LocalAIProvider.ts'
import { requestFeedback } from '../src/records/feedbackClient.ts'
import { fixtureRecord, fixtureFeedback, fixtureContent } from './fixtures/feedback.mjs'

const models = ['gpt-6-luna', 'gpt-6.1-sol'].map(model => ({ model, reasoningEfforts: ['low', 'medium', 'high'] }))
test('four presets are explicit, supported combinations; default feedback is independent of debate', () => {
  assert.equal(defaultPreset('debate'), 'debate-standard')
  assert.equal(defaultPreset('feedback'), 'feedback-standard')
  assert.equal(aiPresets.length, 4)
  for (const preset of aiPresets) {
    const settings = presetSettings(preset.id)
    assert.equal(settingsAvailable(settings, models), true)
    assert.deepEqual(validateModelSettings(settings, models, preset.purpose), settings)
  }
  assert.notEqual(presetSettings('debate-standard').model, presetSettings('debate-advanced').model)
  assert.notEqual(presetSettings('feedback-standard').model, presetSettings('feedback-deep').model)
  assert.equal(presetSettings('feedback-standard').reasoningEffort, 'high')
})
test('unavailable or tampered presets and wrong-purpose settings fail without fallback', () => {
  const standard = presetSettings('debate-standard')
  assert.throws(() => validateModelSettings(standard, [models[1]], 'debate'), /UNSUPPORTED_MODEL_SETTINGS/)
  assert.throws(() => validateModelSettings({ ...standard, reasoningEffort: 'low' }, models), /UNSUPPORTED_MODEL_SETTINGS/)
  assert.throws(() => validateModelSettings(standard, models, 'feedback'), /UNSUPPORTED_MODEL_SETTINGS/)
  assert.throws(() => validateModelSettings({ ...standard, preset: 'unknown' }, models), /UNSUPPORTED_MODEL_SETTINGS/)
  assert.equal(presetMatches({ ...standard, model: 'gpt-6.1-sol' }), false)
  const manual = { model: 'gpt-6.1-sol', reasoningEffort: 'low', preset: 'custom' }
  assert.deepEqual(validateModelSettings(manual, models, 'feedback'), manual)
})
test('debate preset freezes through active/pause, reaches pending request and completed archive, changes next session', () => {
  const standard = presetSettings('debate-standard'), advanced = presetSettings('debate-advanced')
  let state = debateReducer(initialState, { type: 'MODEL_SETTINGS', settings: standard })
  state = debateReducer(state, { type: 'ENGINE', engine: 'real' })
  state = debateReducer(state, { type: 'START', topic: decisionTopic, timestamp: 1000 })
  assert.deepEqual(state.pending.modelSettings, standard)
  assert.equal(debateReducer(state, { type: 'MODEL_SETTINGS', settings: advanced }), state)
  state = debateReducer(state, { type: 'PAUSE', timestamp: 2000 })
  assert.equal(debateReducer(state, { type: 'MODEL_SETTINGS', settings: advanced }), state)
  state = debateReducer(state, { type: 'END', timestamp: 3000 })
  const record = completedRecord(state, 'preset-record')
  assert.deepEqual(record.modelSettings, standard)
  state = debateReducer(state, { type: 'MODEL_SETTINGS', settings: advanced })
  state = debateReducer(state, { type: 'START', topic: decisionTopic, timestamp: 4000 })
  assert.deepEqual(state.pending.modelSettings, advanced)
  assert.deepEqual(state.sessions[0].modelSettings, standard)
  assert.deepEqual(record.modelSettings, standard)
})
test('depth guidance changes but dialogue length, feedback rubric and evidence validator remain shared', () => {
  const request = { speakerId: 'ai1', topic: decisionTopic.title, history: [] }
  const normal = buildPrompt(validateRequest({ ...request, modelSettings: presetSettings('debate-standard') }))
  const advanced = buildPrompt(validateRequest({ ...request, modelSettings: presetSettings('debate-advanced') }))
  assert.match(normal, /일반 토론 연습/); assert.match(advanced, /숨은 전제/)
  assert.match(advanced, /1~3문장/)
  for (const id of ['feedback-standard', 'feedback-deep']) {
    const input = { record: fixtureRecord(), modelSettings: presetSettings(id) }
    const prompt = buildFeedbackPrompt(input)
    assert.ok(prompt.startsWith(feedbackRoleInstruction))
    if (id === 'feedback-deep') assert.match(prompt, /점수나 채점 엄격도를 바꾸지/)
    const result = validateFeedbackReply(JSON.stringify(fixtureContent()), input).feedback
    assert.deepEqual(scoreSummary(result.categories), { score: 78, count: 5 })
    assert.deepEqual(result.modelSettings, input.modelSettings)
    const broken = fixtureContent(); broken.strengths[0].userId = 'missing'
    assert.throws(() => validateFeedbackReply(JSON.stringify(broken), input), /INVALID_EVIDENCE/)
  }
})
test('legacy records/feedback remain unchanged; new presets survive validated serialization', () => {
  const record = fixtureRecord(), feedback = fixtureFeedback()
  assert.deepEqual(parseRecord({ ...record, feedback }), { ...record, feedback })
  const updated = { ...record, modelSettings: presetSettings('debate-advanced'), feedback: { ...feedback, modelSettings: presetSettings('feedback-deep') } }
  assert.deepEqual(parseRecord(JSON.parse(JSON.stringify(updated))), updated)
  assert.deepEqual(parseFeedback(updated.feedback, record).modelSettings, presetSettings('feedback-deep'))
})
test('explicit reanalysis replaces only expected feedback; failed save retains both disk original and in-memory new result', () => {
  const data = new Map(); let fail = false
  const storage = { get length() { return data.size }, key: index => [...data.keys()][index], getItem: key => data.get(key) ?? null,
    setItem(key, value) { if (fail) throw Error('quota'); data.set(key, value) }, removeItem: key => data.delete(key) }
  const repo = createLocalRecordRepository(() => storage), library = createRecordLibrary(repo)
  const record = fixtureRecord(), previous = fixtureFeedback()
  library.capture(record); library.attachFeedback(record.id, previous)
  const next = { ...previous, analyzedAt: previous.analyzedAt + 1, modelSettings: presetSettings('feedback-deep') }
  assert.throws(() => repo.save({ ...record, feedback: next }), /이미 저장된/)
  fail = true; library.attachFeedback(record.id, next, previous)
  assert.deepEqual(repo.list().records[0].feedback, previous)
  assert.deepEqual(library.getSnapshot().entries[0].record.feedback, next)
  library.refresh(); fail = false; library.retry(record.id)
  assert.deepEqual(repo.list().records[0].feedback, next)
  assert.deepEqual(repo.list().records[0].messages, record.messages)
  assert.throws(() => library.attachFeedback(record.id, previous, previous), /변경되었습니다/)
})
test('all four frontend presets reach HTTP inference with identical model, effort and preset metadata', async t => {
  const seen = []
  const app = createDebateServer(async input => {
    seen.push(input.modelSettings)
    return { speakerId: input.speakerId, text: '새로운 근거를 함께 살펴보면 좋겠습니다.', ...input.modelSettings }
  }, { models, analyze: async input => { seen.push(input.modelSettings); return { ...validateFeedbackReply(JSON.stringify(fixtureContent()), input), ...input.modelSettings } } })
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); t.after(() => app.close())
  const original = globalThis.fetch, base = `http://127.0.0.1:${app.server.address().port}`
  t.mock.method(globalThis, 'fetch', (url, options) => original(base + url, options))
  for (const preset of aiPresets) {
    const settings = presetSettings(preset.id)
    if (preset.purpose === 'debate') await localAIProvider.generateReply({ speakerId: 'ai1', topic: decisionTopic.title, history: [], modelSettings: settings }, new AbortController().signal)
    else {
      const reply = await requestFeedback(fixtureRecord(), settings, new AbortController().signal)
      assert.deepEqual(reply.modelSettings, settings)
    }
  }
  assert.deepEqual(seen, aiPresets.map(preset => presetSettings(preset.id)))
})
