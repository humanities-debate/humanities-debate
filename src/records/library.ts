import type { DebateRecord } from './record.ts'
import type { RecordRepository } from './repository.ts'
import { parseFeedback } from './feedback.ts'
import type { Feedback } from './feedback.ts'

export type RecordEntry = { record: DebateRecord; saved: boolean; error: string | null; previousFeedback?: Feedback }
export type LibrarySnapshot = { entries: RecordEntry[]; loadError: string | null }
export function createRecordLibrary(repository: RecordRepository) {
  let snapshot: LibrarySnapshot = { entries: [], loadError: null }
  const listeners = new Set<() => void>()
  const captured = new Set<string>()
  const removed = new Set<string>()
  function publish(entries: RecordEntry[], loadError = snapshot.loadError) {
    snapshot = { entries: [...entries].sort((a, b) => b.record.endedAt - a.record.endedAt), loadError }
    listeners.forEach(listener => listener())
  }
  function refresh() {
    try {
      const { records, warning } = repository.list()
      const pending = snapshot.entries.filter(entry => !entry.saved)
      const pendingIds = new Set(pending.map(entry => entry.record.id))
      publish([...pending, ...records.filter(record => !pendingIds.has(record.id)).map(record => ({ record, saved: true, error: null }))], warning)
    } catch { publish(snapshot.entries, '과거 기록을 읽지 못했습니다. 브라우저 저장 권한을 확인한 뒤 다시 불러와 주세요.') }
  }
  function persist(record: DebateRecord, previousFeedback?: Feedback) {
    let error: string | null = null
    try { repository.save(record, previousFeedback) } catch {
      error = '저장하지 못했습니다. 저장 공간이나 브라우저 설정을 확인하고 다시 저장해 주세요. 이 페이지를 닫거나 새로고침하면 미저장 기록을 잃을 수 있습니다.'
    }
    publish([...snapshot.entries.filter(entry => entry.record.id !== record.id), { record, saved: !error, error, ...(error && previousFeedback ? { previousFeedback } : {}) }])
  }
  refresh()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    capture(record: DebateRecord) {
      if (captured.has(record.id) || removed.has(record.id)) return
      captured.add(record.id)
      persist(record)
    },
    retry(id: string) {
      const entry = snapshot.entries.find(item => item.record.id === id)
      if (entry && !entry.saved) persist(entry.record, entry.previousFeedback)
    },
    attachFeedback(id: string, feedback: Feedback, previousFeedback?: Feedback) {
      const entry = snapshot.entries.find(item => item.record.id === id)
      if (!entry || removed.has(id)) return
      if (JSON.stringify(entry.record.feedback) !== JSON.stringify(previousFeedback)) throw new Error('분석 결과가 변경되었습니다. 현재 결과를 확인한 뒤 다시 요청해 주세요.')
      persist({ ...entry.record, feedback: parseFeedback(feedback, entry.record) }, entry.previousFeedback ?? previousFeedback)
    },
    remove(id: string): boolean {
      const entry = snapshot.entries.find(item => item.record.id === id)
      if (!entry) return false
      try { repository.remove(id) } catch {
        publish(snapshot.entries.map(item => item.record.id === id ? { ...item, error: '삭제하지 못했습니다. 기존 기록은 유지됩니다. 저장 권한을 확인하고 다시 시도해 주세요.' } : item))
        return false
      }
      removed.add(id)
      publish(snapshot.entries.filter(item => item.record.id !== id))
      return true
    },
    refresh,
  }
}
