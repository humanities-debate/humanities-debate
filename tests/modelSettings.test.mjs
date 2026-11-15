import test from 'node:test'
import assert from 'node:assert/strict'
import { modelChoices, defaultModelSettings, validateModelSettings } from '../server/modelCatalog.mjs'
import { createDebateServer } from '../server/http.mjs'
import { debateReducer, initialState } from '../src/logic/debate.ts'
import { decisionTopic } from '../src/data/topics.ts'

const row = (model, reasoningEfforts, extra = {}) => ({ model, displayName: model, defaultReasoningEffort: reasoningEfforts[0], supportedReasoningEfforts: reasoningEfforts.map(reasoningEffort => ({ reasoningEffort })), ...extra })
const models = modelChoices([row('gpt-6.1-sol', ['low', 'medium', 'high']), row('gpt-6-luna', ['low', 'medium']), row('gpt-6-astra', ['high'])])
const settings = { model: 'gpt-6.1-sol', reasoningEffort: 'medium' }

test('picker uses discovered IDs and supported efforts; missing candidates never become guessed options', () => {
  const choices = modelChoices([row('gpt-6-astra', ['ultra', 'high']), row('gpt-6.1-sol', ['low', 'medium']),
    row('not-discovered-candidate', ['medium']), row('gpt-6-luna', ['medium'], { hidden: true })])
  assert.deepEqual(choices.map(item => item.model), ['gpt-6.1-sol', 'gpt-6-astra'])
  assert.deepEqual(choices[1].reasoningEfforts, ['high'])
  assert.deepEqual(defaultModelSettings(choices), settings)
  assert.deepEqual(defaultModelSettings([choices[1]]), { model: 'gpt-6-astra', reasoningEffort: 'high' })
  assert.throws(() => defaultModelSettings([]), /MODELS_UNAVAILABLE/)
})
test('unsupported or missing settings fail with no silent model or effort fallback', () => {
  for (const invalid of [null, {}, { ...settings, model: 'invented' }, { model: 'gpt-6-luna', reasoningEffort: 'high' }, { ...settings, reasoningEffort: 'ultra' }]) {
    assert.throws(() => validateModelSettings(invalid, models), /UNSUPPORTED_MODEL_SETTINGS/)
  }
  assert.deepEqual(validateModelSettings(settings, models), settings)
})
test('model settings freeze through pause and user speech; edits apply only to the next session', () => {
  let state = debateReducer(initialState, { type: 'ENGINE', engine: 'real' })
  assert.equal(debateReducer(state, { type: 'START', topic: decisionTopic, timestamp: 0 }), state)
  state = debateReducer(state, { type: 'MODEL_DEFAULT', settings })
  state = debateReducer(state, { type: 'START', topic: decisionTopic, timestamp: 0 })
  assert.deepEqual(state.pending.modelSettings, settings)
  const changed = { model: 'gpt-6-luna', reasoningEffort: 'low' }
  assert.equal(debateReducer(state, { type: 'MODEL_SETTINGS', settings: changed }), state)
  state = debateReducer(state, { type: 'PAUSE', timestamp: 10 })
  assert.equal(debateReducer(state, { type: 'MODEL_SETTINGS', settings: changed }), state)
  state = debateReducer(state, { type: 'RESUME', timestamp: 20 })
  assert.deepEqual(state.pending.modelSettings, settings)
  state = debateReducer(state, { type: 'USER_START', timestamp: 30 })
  state = debateReducer(state, { type: 'VOICE_FINISH', generationId: state.generationId, timestamp: 40, text: '제 반론입니다.' })
  assert.deepEqual(state.pending.modelSettings, settings)
  state = debateReducer(state, { type: 'END', timestamp: 50 })
  state = debateReducer(state, { type: 'MODEL_SETTINGS', settings: changed })
  assert.deepEqual(state.sessions[0].modelSettings, settings)
  assert.equal(debateReducer(state, { type: 'MODEL_DEFAULT', settings }), state)
  state = debateReducer(state, { type: 'START', topic: decisionTopic, timestamp: 60 })
  assert.deepEqual(state.sessions[1].modelSettings, changed)
  assert.deepEqual(state.pending.modelSettings, changed)
})
test('offline Mock works; switching an unconfigured session to real requires a new session', () => {
  let state = debateReducer(initialState, { type: 'START', topic: decisionTopic, timestamp: 0 })
  assert.equal(state.status, 'aiTyping')
  state = debateReducer(state, { type: 'PAUSE', timestamp: 5 })
  state = debateReducer(state, { type: 'ENGINE', engine: 'real' })
  assert.equal(state.engine, 'mock')
  assert.match(state.error, /모델 설정이 없습니다/)
})
test('HTTP discovery and model selection reach inference; invalid combinations never call the model', async t => {
  const inputs = []
  const app = createDebateServer(async input => {
    inputs.push(input)
    return { speakerId: 'ai1', text: '검증 응답', ...input.modelSettings }
  }, { models, defaultSettings: settings })
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  t.after(() => app.close())
  const base = `http://127.0.0.1:${app.server.address().port}`
  const headers = { 'X-Debate-Client': 'local-ui', 'Content-Type': 'application/json' }
  const catalog = await fetch(base + '/api/models', { headers }).then(response => response.json())
  assert.deepEqual(catalog, { models, defaultSettings: settings })
  headers['X-Debate-Token'] = (await fetch(base + '/api/session', { headers }).then(response => response.json())).token
  let id = 0
  const post = modelSettings => fetch(base + '/api/turn', { method: 'POST', headers,
    body: JSON.stringify({ id: `settings-${id++}`, request: { speakerId: 'ai1', topic: '연습 주제', history: [], modelSettings } }) })
  for (const model of models) for (const reasoningEffort of model.reasoningEfforts) {
    const selected = { model: model.model, reasoningEffort }
    const response = await post(selected)
    assert.equal(response.status, 200)
    assert.deepEqual(inputs.at(-1).modelSettings, selected)
    assert.equal((await response.json()).reasoningEffort, reasoningEffort)
  }
  const calls = inputs.length
  for (const invalid of [{ model: 'unsupported', reasoningEffort: 'low' }, { model: 'gpt-6-luna', reasoningEffort: 'high' }, null]) {
    const response = await post(invalid)
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error, 'UNSUPPORTED_MODEL_SETTINGS')
  }
  assert.equal(inputs.length, calls)
})
