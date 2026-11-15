// Opt-in: two real calls through the same reducer/provider used by React, over local HTTP.
// Console and report contain settings/check results only, never conversations or credentials.
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFile } from 'node:fs/promises'
import { createCodexRuntime } from '../server/codexRuntime.mjs'
import { createDebateServer } from '../server/http.mjs'
import { debateReducer, initialState } from '../src/logic/debate.ts'
import { decisionTopic } from '../src/data/topics.ts'
import { localAIProvider } from '../src/providers/LocalAIProvider.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const report = { success: false, checks: [], stage: 'startup' }
const originalFetch = globalThis.fetch
const originalInfo = console.info
const audits = []
const received = []
let runtime
let app
try {
  runtime = await createCodexRuntime(root)
  report.authentication = 'ChatGPT cached login, no API key'
  report.defaultSettings = runtime.defaultSettings
  // Require two advertised alternatives; never guess IDs or substitute a model.
  const alternatives = runtime.models.filter(model => model.model !== runtime.defaultSettings.model)
  assert.ok(alternatives.length >= 2)
  const selections = alternatives.slice(0, 2).map((model, index) => ({
    model: model.model, reasoningEffort: index === 0 ? 'low' : 'high',
  }))
  for (const selected of selections) assert.ok(runtime.models.find(model => model.model === selected.model)?.reasoningEfforts.includes(selected.reasoningEffort))
  console.info = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[AI model] ')) audits.push(JSON.parse(args[0].slice('[AI model] '.length)))
    originalInfo(...args)
  }
  app = createDebateServer((request, signal) => {
    received.push({ ...request.modelSettings })
    return runtime.generate(request, signal)
  }, { models: runtime.models, defaultSettings: runtime.defaultSettings })
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve) })
  const base = `http://127.0.0.1:${app.server.address().port}`
  // Node has no page origin; resolve only the adapter's relative URLs to our local server.
  globalThis.fetch = (url, options) => originalFetch(typeof url === 'string' && url.startsWith('/api/') ? base + url : url, options)
  let state = debateReducer(initialState, { type: 'ENGINE', engine: 'real' })
  state = debateReducer(state, { type: 'MODEL_DEFAULT', settings: runtime.defaultSettings })
  for (const settings of selections) {
    report.stage = 'session-' + (report.checks.length + 1)
    state = debateReducer(state, { type: 'MODEL_SETTINGS', settings })
    state = debateReducer(state, { type: 'START', topic: decisionTopic, timestamp: Date.now() })
    assert.deepEqual(state.pending.modelSettings, settings)
    assert.deepEqual(state.sessions.at(-1).modelSettings, settings)
    const started = performance.now()
    const reply = await localAIProvider.generateReply(state.pending, new AbortController().signal)
    assert.ok(reply.text.trim())
    const observed = await runtime.readLastExecutionSettings()
    assert.deepEqual(received.at(-1), settings)
    assert.deepEqual(audits.at(-1), { requestedModel: settings.model, sdkModel: settings.model, reasoningEffort: settings.reasoningEffort })
    assert.equal(observed?.model, settings.model)
    assert.equal(observed?.reasoningEffort, settings.reasoningEffort)
    const check = { selected: settings, backendReceived: received.at(-1), sdkInput: audits.at(-1), cliExecution: observed,
      responseReceived: true, elapsedSeconds: Number(((performance.now() - started) / 1000).toFixed(3)) }
    report.checks.push(check)
    console.log(JSON.stringify(check))
    state = debateReducer(state, { type: 'END', timestamp: Date.now() })
  }
  assert.deepEqual(state.sessions.map(session => session.modelSettings), selections)
  report.stage = 'invalid-selection'
  const callsBefore = received.length
  for (const modelSettings of [
    { model: 'unsupported-test-only', reasoningEffort: 'medium' },
    { model: selections[0].model, reasoningEffort: 'unsupported-test-only' },
  ]) {
    state = debateReducer(state, { type: 'START', topic: decisionTopic, timestamp: Date.now() })
    await assert.rejects(() => localAIProvider.generateReply({ ...state.pending, modelSettings }, new AbortController().signal), /선택한 모델 또는 추론 수준이 지원되지 않습니다/)
    state = debateReducer(state, { type: 'END', timestamp: Date.now() })
  }
  assert.equal(received.length, callsBefore)
  assert.equal(audits.length, selections.length)
  report.invalidSettingsRejectedBeforeSDK = true
  report.actualProcessingModel = 'Not independently exposed by the installed SDK events'
  report.success = true
  report.stage = 'complete'
} catch (error) {
  report.error = error?.code ?? 'VERIFICATION_FAILED'
  process.exitCode = 1
} finally {
  globalThis.fetch = originalFetch
  console.info = originalInfo
  await app?.close()
  await runtime?.cleanup()
  await writeFile(path.join(root, '.codex-debate', 'model-routing-verification.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ success: report.success, stage: report.stage, error: report.error, realResponses: report.checks.length }))
}
