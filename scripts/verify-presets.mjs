// Opt-in: four real SDK requests using synthetic material, one per preset.
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFile } from 'node:fs/promises'
import { createCodexRuntime } from '../server/codexRuntime.mjs'
import { createDebateServer } from '../server/http.mjs'
import { fixtureRecord } from '../tests/fixtures/feedback.mjs'
import { requestFeedback } from '../src/records/feedbackClient.ts'
import { localAIProvider } from '../src/providers/LocalAIProvider.ts'
import { scoreSummary } from '../src/records/feedback.ts'
import { aiPresets, presetSettings, settingsAvailable } from '../src/config/aiPresets.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const originalFetch = globalThis.fetch
const report = { success: false, checks: [] }
const selected = process.argv.find(arg => arg.startsWith('--preset='))?.slice('--preset='.length)
const targets = selected ? aiPresets.filter(preset => preset.id === selected) : aiPresets
if (!targets.length) throw new Error('Unknown preset')
let runtime, app
try {
  runtime = await createCodexRuntime(root)
  report.models = runtime.models
  app = createDebateServer(runtime.generate, { models: runtime.models, defaultSettings: runtime.defaultSettings, analyze: runtime.analyze })
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve) })
  globalThis.fetch = (url, options) => originalFetch(`http://127.0.0.1:${app.server.address().port}` + url, options)
  const record = fixtureRecord()
  for (const preset of targets) {
    const requested = presetSettings(preset.id)
    const check = { preset: preset.id, requested, supported: settingsAvailable(requested, runtime.models), success: false }
    report.checks.push(check)
    if (!check.supported) { check.error = 'UNSUPPORTED_MODEL_SETTINGS'; continue }
    const started = performance.now()
    try {
      if (preset.purpose === 'debate') {
        check.reply = await localAIProvider.generateReply({ speakerId: 'ai2', topic: record.topic.title, topicDetails: record.topic, history: record.messages, modelSettings: requested }, new AbortController().signal)
      } else {
        check.feedback = await requestFeedback(record, requested, new AbortController().signal)
        check.score = scoreSummary(check.feedback.categories)
        assert.deepEqual(check.feedback.modelSettings, requested)
      }
      check.observed = await runtime.readLastExecutionSettings()
      assert.equal(check.observed?.model, requested.model)
      assert.equal(check.observed?.reasoningEffort, requested.reasoningEffort)
      check.success = true
    } catch (error) { check.error = error?.code ?? error.message }
    check.elapsedSeconds = Number(((performance.now() - started) / 1000).toFixed(3))
    console.log(JSON.stringify({ preset: check.preset, requested, supported: check.supported, success: check.success, elapsedSeconds: check.elapsedSeconds, error: check.error }))
  }
  report.success = report.checks.length === targets.length && report.checks.every(check => check.success)
  if (!report.success) process.exitCode = 1
} finally {
  globalThis.fetch = originalFetch
  await app?.close(); await runtime?.cleanup()
  await writeFile(path.join(root, '.codex-debate', selected ? `preset-${selected}-verification.json` : 'preset-verification.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ success: report.success, checks: report.checks.length }))
}
