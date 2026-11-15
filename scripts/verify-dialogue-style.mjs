// Opt-in real-model evaluation: nine turns (or three with --brief) consume the account's Codex allowance.
// Metrics describe the sample; they do not automatically grade conversational quality.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFile } from 'node:fs/promises'
import { createCodexRuntime } from '../server/codexRuntime.mjs'
import { validateRequest } from '../server/dialogue.mjs'
import { selectNextSpeaker } from '../src/logic/debate.ts'
import { presetSettings } from '../src/config/aiPresets.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const brief = process.argv.includes('--brief')
const readability = process.argv.includes('--readability')
const topic = readability ? '회사가 AI 도입으로 줄인 인건비를 해고된 직원의 재교육에 우선 써야 할까?' : '의료 AI가 응급 상황에서 인간의 사전 승인 없이 치료를 결정하도록 허용해야 하는가?'
const history = []
const report = { success: false, topic, authentication: 'not_verified', turns: [], history }
const segmenter = new Intl.Segmenter('ko', { granularity: 'sentence' })
const controller = new AbortController()
const interrupt = () => controller.abort()
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)
let runtime
function add(speakerId, text) {
  history.push({ id: `m-${history.length + 1}`, turnId: history.length + 1, speakerId, text, isUser: speakerId === 'user' })
}
try {
  runtime = await createCodexRuntime(root)
  report.authentication = 'ChatGPT cached login, no API key'
  const modelSettings = readability ? presetSettings('debate-standard') : runtime.defaultSettings
  report.requestedSettings = modelSettings
  for (let index = 0; index < (brief ? 3 : readability ? 6 : 9); index++) {
    const speakerId = selectNextSpeaker(history)
    const reply = await runtime.generate(validateRequest({ speakerId, topic, history, modelSettings }), controller.signal)
    const sentences = [...segmenter.segment(reply.text)].filter(item => item.segment.trim()).length
    const normalized = reply.text.replace(/\s+/g, '')
    const exactRepeat = history.some(message => message.text.replace(/\s+/g, '') === normalized)
    const metrics = { ...reply, sentences, characters: reply.text.length, opening: reply.text.slice(0, 25),
      endsWithQuestion: /[?？]$/.test(reply.text), exactRepeat }
    report.turns.push(metrics)
    add(speakerId, reply.text)
    console.log(JSON.stringify({ turn: index + 1, ...metrics }))
    if (index === 0) add('user', readability
      ? '남은 직원들은 AI 사용법을 배우고 동료가 하던 일까지 맡게 됐습니다. 저는 남은 직원들의 임금을 먼저 올려야 한다고 봅니다. 예산이 부족해 둘 중 하나만 먼저 지원할 수 있다고 가정하면, 해고된 직원의 재교육부터 지원하는 게 공정할까요?'
      : '응급실에서는 사전 승인을 기다리다가 환자가 사망할 수도 있습니다. 지연에 따른 피해도 책임 판단에 포함해야 하지 않을까요? 사후 책임은 의료기관이 지되 AI가 먼저 조치하는 방안을 제안합니다.')
    if (index === 4) add('user', '지금 서로 다르게 보는 부분을 중심으로, 상대 의견을 듣고도 자기 선택을 유지하거나 바꾸는 이유를 설명해 주시겠어요?')
  }
  report.bySpeaker = Object.fromEntries(['ai1', 'ai2', 'ai3'].map(id => [id, report.turns.filter(turn => turn.speakerId === id).map(turn => ({ sentences: turn.sentences, characters: turn.characters }))]))
  report.success = true
  console.log(JSON.stringify({ success: true, bySpeaker: report.bySpeaker }))
} catch (error) {
  report.error = controller.signal.aborted ? 'CANCELLED' : error?.code ?? 'VERIFICATION_FAILED'
  console.error('실제 대화 검증 중단: ' + report.error)
  process.exitCode = 1
} finally {
  await runtime?.cleanup()
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
  await writeFile(path.join(root, '.codex-debate', readability ? 'readability-verification.json' : brief ? 'immersion-verification.json' : 'style-verification.json'), JSON.stringify(report, null, 2))
}
