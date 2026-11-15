// Opt-in: 3 baseline or 9 candidate AI turns using existing ChatGPT authentication.
// No automatic retry/judge calls. Synthetic scenario, not private user history.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { createCodexRuntime } from '../server/codexRuntime.mjs'
import { buildPrompt, validateRequest } from '../server/dialogue.mjs'
import { presetSettings } from '../src/config/aiPresets.ts'
import { selectNextSpeaker } from '../src/logic/debate.ts'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baseline = process.argv.includes('--baseline')
const count = baseline ? 3 : process.argv.includes('--eight') ? 8 : 9
const topic = '훨씬 오래 살게 된다면 여러 번 배우고 직업을 바꾸는 삶이 기본이 되어야 할까?'
const topicContext = { situation: '건강하게 사는 기간이 크게 늘어난 미래를 가정합니다. 학교와 회사는 중간에 다시 배우고 직업을 바꾸는 과정을 늘리려 합니다.', keyIssue: '오래 일할 기회를 넓히는 일과 익숙한 삶을 이어갈 선택을 어떻게 함께 보장할까요?' }
const history = [{ id: 'eval-1', turnId: 1, speakerId: 'user', isUser: true, text: '그렇다면 원하는 사람에게는 교육 기회를 주고 원하지 않는 사람은 그대로 놔두면 되지 않을까요?' }]
const modelSettings = presetSettings('debate-standard')
const report = { success: false, baseline, synthetic: true, topic, topicContext, modelSettings, initialHistory: structuredClone(history), turns: [] }
const controller = new AbortController()
const abort = () => controller.abort()
process.once('SIGINT', abort); process.once('SIGTERM', abort)
let runtime
try {
  runtime = await createCodexRuntime(root)
  report.authentication = 'existing ChatGPT login; no API key'
  for (let i = 0; i < count; i++) {
    const speakerId = selectNextSpeaker(history)
    const request = validateRequest({ speakerId, topic, topicContext, history, modelSettings })
    const promptCharacters = buildPrompt(request).length
    const reply = await runtime.generate(request, controller.signal)
    const metric = { ...reply, turn: i + 1, promptCharacters,
      sentences: [...new Intl.Segmenter('ko', { granularity: 'sentence' }).segment(reply.text)].length }
    report.turns.push(metric)
    history.push({ id: `eval-${history.length + 1}`, turnId: history.length + 1, speakerId, text: reply.text, isUser: false })
    console.log(JSON.stringify(metric))
  }
  report.execution = await runtime.readLastExecutionSettings()
  report.success = true
} catch (error) {
  report.error = controller.signal.aborted ? 'CANCELLED' : error.code ?? 'VERIFICATION_FAILED'
  console.error(report.error); process.exitCode = 1
} finally {
  await runtime?.cleanup()
  process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort)
  const dir = path.join(root, '.codex-debate', 'debate-progress')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, baseline ? 'before.json' : 'after.json'), JSON.stringify(report, null, 2))
}
