import { parseRecord } from './record.ts'
import type { DebateRecord } from './record.ts'
import type { Feedback } from './feedback.ts'

export const RECORD_KEY_PREFIX = 'skhynix-debate:record:'
export type RecordRead = { records: DebateRecord[]; warning: string | null }
export interface RecordRepository {
  list(): RecordRead
  save(record: DebateRecord, previousFeedback?: Feedback): void
  remove(id: string): void
}
type StorageAccess = () => Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>

// Immutable transcript plus optional validated feedback in one atomic localStorage value.
// An installer can replace this adapter without changing result screens or the debate engine.
export function createLocalRecordRepository(access: StorageAccess = () => window.localStorage): RecordRepository {
  return {
    list() {
      const storage = access()
      const records: DebateRecord[] = []
      let invalid = 0
      const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => Boolean(key?.startsWith(RECORD_KEY_PREFIX)))
      for (const key of keys) {
        const raw = storage.getItem(key)
        if (raw === null) continue
        try {
          const parsed = JSON.parse(raw)
          let record: DebateRecord
          try { record = parseRecord(parsed) } catch (error) {
            if (!parsed?.feedback) throw error
            record = parseRecord({ ...parsed, feedback: undefined })
            invalid++ // Keep the transcript readable even if its feedback cannot be validated.
          }
          if (key !== RECORD_KEY_PREFIX + record.id) throw new Error('ID mismatch')
          records.push(record)
        } catch { invalid++ } // Preserve unreadable/newer records verbatim, never erase them.
      }
      return { records, warning: invalid ? `${invalid}개 기록 또는 피드백의 형식·근거·버전을 읽을 수 없습니다. 저장된 원본은 삭제하지 않았습니다.` : null }
    },
    save(record, previousFeedback) {
      const safe = parseRecord(record)
      const storage = access()
      const key = RECORD_KEY_PREFIX + safe.id
      const serialized = JSON.stringify(safe)
      const existing = storage.getItem(key)
      if (existing !== null && existing !== serialized) {
        const previous = JSON.parse(existing)
        const base = parseRecord({ ...previous, feedback: undefined })
        if (JSON.stringify(base) !== JSON.stringify({ ...safe, feedback: undefined })) throw new Error('같은 ID의 다른 기록을 덮어쓸 수 없습니다.')
        // Once valid feedback exists, loading/saving an older snapshot cannot erase or replace it.
        if (previous.feedback) {
          let valid = false
          try { parseRecord(previous); valid = true } catch { /* allow repairing invalid feedback, never the transcript */ }
          if (valid) {
            if (!safe.feedback) return
            const savedFeedback = JSON.stringify(parseRecord(previous).feedback)
            if (savedFeedback !== JSON.stringify(safe.feedback) && savedFeedback !== JSON.stringify(previousFeedback)) throw new Error('이미 저장된 분석이 있습니다. 기록을 다시 불러와 주세요.')
          }
        }
      }
      if (existing !== serialized) storage.setItem(key, serialized)
    },
    remove(id) { access().removeItem(RECORD_KEY_PREFIX + id) },
  }
}
