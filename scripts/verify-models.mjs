// Opt-in live test: discovers models, then calls each advertised Low/Medium/High combination.
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFile } from 'node:fs/promises'
import { createCodexRuntime } from '../server/codexRuntime.mjs'
import { createDebateServer } from '../server/http.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const report = { success: false, authentication: 'not_verified', models: [], checks: [] }
let runtime
let app
try {
  runtime = await createCodexRuntime(root)
  report.authentication = 'ChatGPT cached login, no API key'
  app = createDebateServer(runtime.generate, { models: runtime.models, defaultSettings: runtime.defaultSettings })
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve) })
  const base = `http://127.0.0.1:${app.server.address().port}`
  const headers = { 'X-Debate-Client': 'local-ui', 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' }
  const session = await fetch(base + '/api/session', { headers }).then(response => response.json())
  headers['X-Debate-Token'] = session.token
  const catalog = await fetch(base + '/api/models', { headers }).then(response => response.json())
  report.models = catalog.models
  report.defaultSettings = catalog.defaultSettings
  console.log(JSON.stringify(catalog))
  const request = { speakerId: 'ai2', topic: '학교에서 AI 도구 사용을 허용해야 하는가?', history: [] }
  let id = 0
  const post = modelSettings => fetch(base + '/api/turn', { method: 'POST', headers,
    body: JSON.stringify({ id: `model-check-${id++}`, request: { ...request, modelSettings } }) })
  for (const model of catalog.models) {
    for (const reasoningEffort of model.reasoningEfforts) {
      const requested = { model: model.model, reasoningEffort }
      const response = await post(requested)
      const result = await response.json()
      const observed = response.ok ? await runtime.readLastExecutionSettings() : null
      const success = response.ok && result.model === requested.model && result.reasoningEffort === reasoningEffort &&
        observed?.model === requested.model && observed?.reasoningEffort === reasoningEffort
      const check = { requested, observed, success, result }
      report.checks.push(check)
      console.log(JSON.stringify(check))
    }
  }
  const invalid = await post({ model: 'unsupported-test-only', reasoningEffort: 'medium' })
  const invalidBody = await invalid.json()
  assert.equal(invalid.status, 400)
  assert.equal(invalidBody.error, 'UNSUPPORTED_MODEL_SETTINGS')
  const invalidEffort = await post({ model: catalog.models[0].model, reasoningEffort: 'invalid-effort' })
  assert.equal(invalidEffort.status, 400)
  assert.equal((await invalidEffort.json()).error, 'UNSUPPORTED_MODEL_SETTINGS')
  report.invalidSettingsRejected = true
  report.success = report.checks.length > 0 && report.checks.every(check => check.success)
  if (!report.success) process.exitCode = 1
} catch (error) {
  report.error = error?.code ?? 'VERIFICATION_FAILED'
  process.exitCode = 1
} finally {
  await app?.close()
  await runtime?.cleanup()
  await writeFile(path.join(root, '.codex-debate', 'model-verification.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ success: report.success, error: report.error, checks: report.checks.length }))
}
