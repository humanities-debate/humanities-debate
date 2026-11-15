// Opt-in live integration test. Uses the ChatGPT account's Codex allowance.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFile } from 'node:fs/promises'
import { createCodexRuntime } from '../server/codexRuntime.mjs'
import { createDebateServer } from '../server/http.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let runtime
let app
const report = { success: false, authentication: 'not_verified', turns: [], cancellation: null }
try {
  runtime = await createCodexRuntime(root)
  report.authentication = 'ChatGPT cached login, no API key'
  app = createDebateServer(runtime.generate, { models: runtime.models, defaultSettings: runtime.defaultSettings })
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve) })
  const base = `http://127.0.0.1:${app.server.address().port}`
  const headers = { 'X-Debate-Client': 'local-ui', 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' }
  const { token } = await fetch(base + '/api/session', { headers }).then(r => r.json())
  headers['X-Debate-Token'] = token
  const history = []
  const topic = '의료 AI가 응급 상황에서 인간의 사전 승인 없이 치료를 결정하도록 허용해야 하는가?'
  const post = (route, body) => fetch(base + '/api/' + route, { method: 'POST', headers, body: JSON.stringify(body) })
  for (const [index, speakerId] of ['ai1', 'ai2', 'ai3', 'ai1'].entries()) {
    const response = await post('turn', { id: `live-${index}`, request: { speakerId, topic, history, modelSettings: runtime.defaultSettings } })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error)
    report.turns.push(data)
    console.log(JSON.stringify(data))
    history.push({ id: `m-${history.length + 1}`, turnId: history.length + 1, speakerId, text: data.text, isUser: false })
    if (index === 0) history.push({ id: 'm-2', turnId: 2, speakerId: 'user', isUser: true,
      text: '응급실에서는 사전 승인을 기다리다가 환자가 사망할 수도 있습니다. 지연에 따른 피해도 책임 판단에 포함해야 하지 않을까요? 사후 책임은 의료기관이 지되 AI가 먼저 조치하는 방안을 제안합니다.' })
  }
  const pending = post('turn', { id: 'live-cancel', request: { speakerId: 'ai2', topic, history, modelSettings: runtime.defaultSettings } })
  await new Promise(resolve => setTimeout(resolve, 700))
  await post('cancel', { id: 'live-cancel' })
  const cancelled = await pending
  report.cancellation = { status: cancelled.status, result: await cancelled.json() }
  if (cancelled.status !== 409 || report.cancellation.result.error !== 'CANCELLED') throw new Error('Cancellation failed')
  report.success = true
  console.log('실제 4회 응답 및 진행 중 요청 취소 확인')
} catch (error) {
  // Runtime/HTTP errors are sanitized error codes only.
  report.error = error?.code ?? error?.message ?? 'Verification failed'
  console.error('검증 실패: ' + report.error)
  process.exitCode = 1
} finally {
  await app?.close()
  await runtime?.cleanup()
  await writeFile(path.join(root, '.codex-debate', 'verification.json'), JSON.stringify(report, null, 2))
}
