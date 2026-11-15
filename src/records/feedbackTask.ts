import type { DebateRecord } from './record.ts'
import type { Feedback } from './feedback.ts'
import { insufficientEvidence, parseFeedback } from './feedback.ts'
import type { ModelSettings } from '../types/debate.ts'

type Snapshot = { running: boolean; error: string | null }
type Analyze = (record: DebateRecord, settings: ModelSettings, signal: AbortSignal) => Promise<Feedback>
// Explicit start only. Generation checks also discard replies from providers that ignore abort.
export function createFeedbackTask(record: DebateRecord, analyze: Analyze, save: (feedback: Feedback) => void) {
  let snapshot: Snapshot = { running: false, error: null }
  let generation = 0
  let controller: AbortController | null = null
  let completed = Boolean(record.feedback)
  const listeners = new Set<() => void>()
  const publish = (next: Snapshot) => { snapshot = next; listeners.forEach(listener => listener()) }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async start(settings: ModelSettings) {
      if (controller || completed) return
      const reason = insufficientEvidence(record)
      if (reason) { publish({ running: false, error: reason }); return }
      const current = ++generation
      const active = new AbortController()
      controller = active
      publish({ running: true, error: null })
      try {
        const feedback = await analyze(record, settings, active.signal)
        if (current !== generation || active.signal.aborted) return
        save(parseFeedback(feedback, record))
        completed = true
        publish({ running: false, error: null })
      } catch (error) {
        if (current !== generation || active.signal.aborted) return
        publish({ running: false, error: error instanceof Error ? error.message : '분석에 실패했습니다. 다시 시도해 주세요.' })
      } finally { if (current === generation) controller = null }
    },
    cancel() { generation++; controller?.abort(); controller = null; publish({ running: false, error: null }) },
  }
}
