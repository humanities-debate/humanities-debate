// Opt-in: one real call through the React provider and local HTTP server.
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFile } from 'node:fs/promises'
import { createCodexRuntime } from '../server/codexRuntime.mjs'
import { createDebateServer } from '../server/http.mjs'
import { buildPrompt } from '../server/dialogue.mjs'
import { practiceTopics } from '../src/data/topics.ts'
import { debateReducer, initialState } from '../src/logic/debate.ts'
import { localAIProvider } from '../src/providers/LocalAIProvider.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const topic = practiceTopics.find(item => item.id === 'ai-care')
const report = { success: false, topic }
const originalFetch = globalThis.fetch
let runtime
let app
try {
  runtime = await createCodexRuntime(root)
  app = createDebateServer((request, signal) => {
    assert.equal(request.topic, topic.title)
    assert.deepEqual(request.topicContext, topic.context)
    const promptData = JSON.parse(buildPrompt(request).split('\n').at(-1))
    assert.deepEqual(promptData.topicContext, topic.context)
    report.contextReachedSDKPrompt = true
    return runtime.generate(request, signal)
  }, { models: runtime.models, defaultSettings: runtime.defaultSettings })
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve) })
  const base = `http://127.0.0.1:${app.server.address().port}`
  globalThis.fetch = (url, options) => originalFetch(base + url, options)
  let state = debateReducer(initialState, { type: 'ENGINE', engine: 'real' })
  state = debateReducer(state, { type: 'MODEL_SETTINGS', settings: runtime.defaultSettings })
  state = debateReducer(state, { type: 'START', topic, timestamp: Date.now() })
  const started = performance.now()
  const reply = await localAIProvider.generateReply(state.pending, new AbortController().signal)
  assert.ok(reply.text.trim())
  report.response = reply.text
  report.settings = runtime.defaultSettings
  report.elapsedSeconds = Number(((performance.now() - started) / 1000).toFixed(3))
  report.success = true
} catch (error) {
  report.error = error?.code ?? 'VERIFICATION_FAILED'
  process.exitCode = 1
} finally {
  globalThis.fetch = originalFetch
  await app?.close()
  await runtime?.cleanup()
  await writeFile(path.join(root, '.codex-debate', 'topic-context-verification.json'), JSON.stringify(report, null, 2))
  // Do not log prompt contents or credentials; the synthetic response stays in the ignored report.
  console.log(JSON.stringify({ success: report.success, contextReachedSDKPrompt: report.contextReachedSDKPrompt,
    settings: report.settings, elapsedSeconds: report.elapsedSeconds, error: report.error }))
}
