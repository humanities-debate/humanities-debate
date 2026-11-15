import { AIProviderError } from './AIProvider.ts'
import type { AIProvider } from './AIProvider.ts'
import { aiConnectionHelp } from '../desktop.ts'
import { parseDiscussion, discussionFocus } from '../logic/discussion.ts'
import { parseContribution } from '../logic/contribution.ts'
import type { Contribution } from '../logic/contribution.ts'
import type { DiscussionState } from '../logic/discussion.ts'
import { metadataDiagnostic, logMetadataDiagnostic } from '../logic/debateMetadata.ts'

const errors: Record<string, string> = {
  CHATGPT_LOGIN_REQUIRED: 'ChatGPT 로그인을 확인할 수 없습니다.',
  SHARING_REQUIRED: '공식 ChatGPT 연결에서 구독 사용 동의를 확인해 주세요.',
  NETWORK: 'OpenAI 연결이 끊겼습니다. 기록은 유지됩니다. 네트워크를 확인한 뒤 재개해 주세요.',
  LIMIT: '계정 사용량 제한 또는 모델 사용 제한입니다. 잠시 후 재시도해 주세요.',
  TIMEOUT: 'AI 응답이 제한 시간 안에 도착하지 않았습니다.',
  INVALID_REPLY: 'AI 응답 형식이나 발언자 정보가 올바르지 않습니다.',
  REPETITION: 'AI가 이전 발언을 반복하여 응답을 보류했습니다.',
  STANCE_MISMATCH: 'AI 첫 발언의 실제 주장이 배정된 입장과 맞지 않거나 모호해 표시를 보류했습니다.',
  STANCE_UNVERIFIED: '토론의 대립 입장이나 AI 첫 발언을 확인하지 못해 표시를 보류했습니다.',
  INTERNAL_STANCE_LABEL: 'AI 발언에 내부 입장 표시가 포함되어 표시를 보류했습니다.',
  CONTEXT_LIMIT: '전달할 대화가 너무 길어졌습니다. 기록을 확인하고 새 토론을 시작해 주세요.',
  BUSY: '다른 AI 요청을 정리하고 있습니다. 잠시 후 재개해 주세요.',
  FORBIDDEN_TOOL: '허용하지 않은 도구 사용이 감지되어 AI 호출을 중단했습니다.',
  UNSUPPORTED_MODEL_SETTINGS: '선택한 모델 또는 추론 수준이 지원되지 않습니다. 토론을 종료한 뒤 모델 목록을 다시 확인해 주세요.',
}
const headers = { 'Content-Type': 'application/json', 'X-Debate-Client': 'local-ui' }

export const localAIProvider: AIProvider = {
  async generateReply(request, signal) {
    signal.throwIfAborted()
    if (!request.modelSettings) throw new AIProviderError('토론 시작 전에 AI 모델과 추론 수준을 선택해 주세요.')
    const id = crypto.randomUUID()
    let token: string | undefined
    let posted = false
    const cancel = () => {
      if (!posted || !token) return
      // Explicit cancellation also crosses Vite proxies that keep upstream sockets alive.
      void fetch('/api/cancel', { method: 'POST', headers: { ...headers, 'X-Debate-Token': token },
        body: JSON.stringify({ id }), keepalive: true }).catch(() => {})
    }
    const timeout = AbortSignal.timeout(150_000)
    const combined = AbortSignal.any([signal, timeout])
    combined.addEventListener('abort', cancel, { once: true })
    try {
      combined.throwIfAborted()
      const session = await fetch('/api/session', { headers, signal: combined, cache: 'no-store' })
      if (!session.ok) throw new AIProviderError(aiConnectionHelp())
      const credentials: unknown = await session.json()
      if (!credentials || typeof credentials !== 'object' || !('token' in credentials) || typeof credentials.token !== 'string') throw new Error('Invalid local session')
      token = credentials.token
      combined.throwIfAborted()
      posted = true
      const response = await fetch('/api/turn', { method: 'POST', signal: combined,
        headers: { ...headers, 'X-Debate-Token': token },
        body: JSON.stringify({ id, request: { speakerId: request.speakerId, topic: request.topic,
          topicContext: request.topicDetails?.context, history: request.history, modelSettings: request.modelSettings,
          ...(request.contributions ? { contributions: request.contributions } : {}), ...(request.discussion ? { discussion: request.discussion } : {}) } }) })
      const data = await response.json() as { id?: unknown; speakerId?: unknown; text?: unknown; discussion?: unknown; contribution?: unknown; error?: string; model?: unknown; reasoningEffort?: unknown; preset?: unknown }
      if (!response.ok) throw new AIProviderError(data.error === 'CHATGPT_LOGIN_REQUIRED' ? errors.CHATGPT_LOGIN_REQUIRED + ' ' + aiConnectionHelp() : errors[data.error ?? ''] ?? aiConnectionHelp())
      combined.throwIfAborted()
      if (data.model !== request.modelSettings.model || data.reasoningEffort !== request.modelSettings.reasoningEffort || data.preset !== request.modelSettings.preset) throw new AIProviderError('요청한 모델·추론 설정과 응답 정보가 달라 발언을 표시하지 않았습니다.')
      if (data.id !== id || data.speakerId !== request.speakerId || typeof data.text !== 'string' || !data.text.trim() || data.text.length > 1600) throw new AIProviderError(errors.INVALID_REPLY)
      let discussion: DiscussionState | undefined, contribution: Contribution | undefined
      try { if (data.discussion !== undefined) discussion = parseDiscussion(data.discussion, request.topic, request.history, true) }
      catch (error) { logMetadataDiagnostic(metadataDiagnostic(error)) }
      try { if (data.contribution !== undefined) contribution = parseContribution(data.contribution, request.history, discussionFocus(request.discussion ?? null, request.speakerId, request.history, request.contributions)) }
      catch (error) { logMetadataDiagnostic(metadataDiagnostic(error)) }
      return { text: data.text, ...(discussion ? { discussion } : {}), ...(contribution ? { contribution } : {}) }
    } catch (error) {
      signal.throwIfAborted()
      if (timeout.aborted) throw new AIProviderError(errors.TIMEOUT)
      if (error instanceof AIProviderError) throw error
      throw new AIProviderError('로컬 AI 서버에 연결할 수 없습니다. ' + aiConnectionHelp())
    } finally {
      combined.removeEventListener('abort', cancel)
    }
  },
}
