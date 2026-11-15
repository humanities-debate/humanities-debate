// Opt-in live verification: synthetic transcript, one feedback call + one debate regression call.
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const originalFetch = globalThis.fetch
const report = { success: false }
let runtime, app
try {
  runtime = await createCodexRuntime(root)
  app = createDebateServer(runtime.generate, { models: runtime.models, defaultSettings: runtime.defaultSettings, analyze: runtime.analyze })
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve) })
  const base = `http://127.0.0.1:${app.server.address().port}`
  globalThis.fetch = (url, options) => originalFetch(base + url, options)
  const record = fixtureRecord()
  const started = performance.now()
  report.feedback = await requestFeedback(record, runtime.defaultSettings, new AbortController().signal)
  report.elapsedSeconds = Number(((performance.now() - started) / 1000).toFixed(3))
  report.score = scoreSummary(report.feedback.categories)
  report.sdkSettings = await runtime.readLastExecutionSettings()
  assert.ok(report.feedback.categories.length === 5)
  const reply = await localAIProvider.generateReply({ speakerId: 'ai2', topic: record.topic.title, topicDetails: record.topic,
    history: record.messages, modelSettings: runtime.defaultSettings }, new AbortController().signal)
  assert.ok(reply.text.trim())
  report.debateReply = reply.text
  report.success = true
} catch (error) {
  report.error = error?.code ?? error?.message ?? 'VERIFICATION_FAILED'
  process.exitCode = 1
} finally {
  globalThis.fetch = originalFetch
  await app?.close()
  await runtime?.cleanup()
  await writeFile(path.join(root, '.codex-debate', 'feedback-live-verification.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ success: report.success, score: report.score, elapsedSeconds: report.elapsedSeconds,
    sdkSettings: report.sdkSettings, debateRegression: Boolean(report.debateReply), error: report.error }))
}
