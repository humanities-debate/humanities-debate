import type { DebateRecord } from './record.ts'
import { parseFeedback } from './feedback.ts'
import type { ModelSettings } from '../types/debate.ts'
import { aiConnectionHelp } from '../desktop.ts'

const errors: Record<string, string> = {
  CHATGPT_LOGIN_REQUIRED: 'ChatGPT 인증이 만료되었거나 로그인을 확인할 수 없습니다.',
  SHARING_REQUIRED: '공식 ChatGPT 연결에서 구독 사용 동의를 확인해 주세요.',
  NETWORK: 'OpenAI 연결이 끊겼습니다. 원본 기록은 유지됩니다. 네트워크를 확인하고 다시 요청해 주세요.',
  LIMIT: 'ChatGPT 사용량 또는 모델 사용 한도에 도달했습니다. 사용량이 회복된 뒤 다시 시도해 주세요.',
  TIMEOUT: '분석 제한 시간을 초과했습니다. 잠시 후 다시 시도해 주세요.',
  INVALID_FEEDBACK: 'AI 분석의 JSON 형식이나 점수가 올바르지 않아 표시하지 않았습니다. 다시 시도해 주세요.',
  INVALID_EVIDENCE: 'AI 분석 근거가 원본 발언의 ID·참가자·순서와 일치하지 않아 표시하지 않았습니다. 다시 시도해 주세요.',
  INVALID_REQUEST: '분석할 기록의 형식을 확인하지 못했습니다. 원본 기록은 유지됩니다.',
  CONTEXT_LIMIT: '전체 기록이 분석 입력 한도를 초과했습니다(500개 발언·JSON 16만 자, 전송 1MB). 일부를 누락해 분석하지 않습니다.',
  INSUFFICIENT_EVIDENCE: '평가 보류: 사용자 발언이 부족하여 분석하지 않았습니다.',
  DUPLICATE: '이 기록의 분석 요청이 이미 처리 중입니다. 잠시 기다린 뒤 확인해 주세요.',
  BUSY: '다른 AI 요청을 정리하고 있습니다. 잠시 후 다시 시도해 주세요.',
  UNSUPPORTED_MODEL_SETTINGS: '선택한 모델 또는 추론 수준이 지원되지 않습니다. 설정을 확인해 주세요. 다른 모델로 자동 전환하지 않습니다.',
  FORBIDDEN_TOOL: '허용되지 않은 도구 사용이 감지되어 분석을 중단했습니다.',
  CANCELLED: '분석이 취소되었습니다.',
}
const headers = { 'Content-Type': 'application/json', 'X-Debate-Client': 'local-ui' }
export async function requestFeedback(record: DebateRecord, modelSettings: ModelSettings, signal: AbortSignal) {
  const id = crypto.randomUUID()
  const timeout = AbortSignal.timeout(150_000)
  const combined = AbortSignal.any([signal, timeout])
  let token: string | undefined
  let posted = false
  const cancel = () => {
    if (posted && token) void fetch('/api/cancel', { method: 'POST', headers: { ...headers, 'X-Debate-Token': token }, body: JSON.stringify({ id }), keepalive: true }).catch(() => {})
  }
  combined.addEventListener('abort', cancel, { once: true })
  try {
    combined.throwIfAborted()
    const session = await fetch('/api/session', { headers, signal: combined, cache: 'no-store' })
    if (!session.ok) throw new Error(aiConnectionHelp())
    const local = await session.json()
    if (typeof local?.token !== 'string') throw new Error('로컬 서버 연결 정보를 확인하지 못했습니다.')
    token = local.token
    combined.throwIfAborted()
    posted = true
    const response = await fetch('/api/feedback', { method: 'POST', headers: { ...headers, 'X-Debate-Token': token! }, signal: combined,
      body: JSON.stringify({ id, request: { record: { ...record, feedback: undefined }, modelSettings } }) })
    const data = await response.json()
    combined.throwIfAborted()
    if (!response.ok) throw new Error(data.error === 'CHATGPT_LOGIN_REQUIRED' ? errors.CHATGPT_LOGIN_REQUIRED + ' ' + aiConnectionHelp() : errors[data.error] ?? aiConnectionHelp())
    if (data.id !== id || data.model !== modelSettings.model || data.reasoningEffort !== modelSettings.reasoningEffort || data.preset !== modelSettings.preset) throw new Error('분석 요청과 응답의 모델·추론 설정이 일치하지 않습니다.')
    const feedback = parseFeedback(data.feedback, record)
    if (feedback.modelSettings.model !== modelSettings.model || feedback.modelSettings.reasoningEffort !== modelSettings.reasoningEffort || feedback.modelSettings.preset !== modelSettings.preset) throw new Error('저장할 분석의 모델 정보가 요청과 일치하지 않습니다.')
    return feedback
  } catch (error) {
    signal.throwIfAborted()
    if (timeout.aborted) throw new Error(errors.TIMEOUT, { cause: error })
    if (error instanceof TypeError || error instanceof SyntaxError) throw new Error('서버 연결 또는 응답 형식을 확인하지 못했습니다. ' + aiConnectionHelp(), { cause: error })
    throw error
  } finally { combined.removeEventListener('abort', cancel) }
}
