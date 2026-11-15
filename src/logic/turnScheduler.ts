import { AI_TYPING_MS } from './debate.ts'
import type { DebateAction, DebateState } from './debate.ts'
import type { AIProvider } from '../providers/AIProvider.ts'
import { AIProviderError } from '../providers/AIProvider.ts'

export type TurnSchedule = Pick<DebateState, 'status' | 'generationId' | 'pending' | 'waitUntil'>

function typingDelay(signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(false); return }
    const cancel = () => { clearTimeout(timer); resolve(false) }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel)
      resolve(true)
    }, AI_TYPING_MS)
    signal.addEventListener('abort', cancel, { once: true })
  })
}

// One cancellable lifecycle per turn. React cleanup and user actions share this path.
export function scheduleTurn(state: TurnSchedule, dispatch: (action: DebateAction) => void, provider: AIProvider): () => void {
  const controller = new AbortController()
  const { signal } = controller
  const generationId = state.generationId
  if (state.status === 'aiShowing' && state.waitUntil !== null) {
    const timer = setTimeout(() => {
      if (!signal.aborted) dispatch({ type: 'WAIT_ELAPSED', generationId, timestamp: Date.now() })
    }, Math.max(0, state.waitUntil - Date.now()))
    return () => { controller.abort(); clearTimeout(timer) }
  }
  if (state.status === 'aiTyping' && state.pending) {
    const request = state.pending
    void Promise.all([
      Promise.resolve().then(() => {
        signal.throwIfAborted()
        return provider.generateReply(request, signal)
      }),
      typingDelay(signal),
    ]).then(([reply, ready]) => {
      if (!ready || signal.aborted) return
      if (!reply.text.trim()) throw new Error('Empty AI reply')
      dispatch({ type: 'AI_READY', text: reply.text, ...(reply.discussion ? { discussion: reply.discussion } : {}),
        ...(reply.contribution ? { contribution: reply.contribution } : {}), generationId, timestamp: Date.now() })
    }).catch((error: unknown) => {
      if (signal.aborted) return
      controller.abort()
      dispatch({ type: 'AI_ERROR', generationId, timestamp: Date.now(), message: error instanceof AIProviderError ? error.message : undefined })
    })
  }
  return () => controller.abort()
}
