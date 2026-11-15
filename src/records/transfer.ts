import { parseRecord } from './record.ts'
import type { DebateRecord } from './record.ts'
import { RECORD_KEY_PREFIX } from './repository.ts'

type Store = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>
export type RecordBackup = { format: 'humanities-debate-backup'; version: 1; ownership: 'unassigned'; createdAt: string; items: { key: string; value: string }[] }
export function backupRecords(storage: Store, pending: DebateRecord[] = []): RecordBackup {
  const items = new Map<string, string>()
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (key?.startsWith(RECORD_KEY_PREFIX)) {
      const raw = storage.getItem(key)
      if (raw !== null) items.set(key, raw) // Preserve unreadable records in backups too.
    }
  }
  for (const record of pending) if (!items.has(RECORD_KEY_PREFIX + record.id)) items.set(RECORD_KEY_PREFIX + record.id, JSON.stringify(parseRecord(record)))
  return { format: 'humanities-debate-backup', version: 1, ownership: 'unassigned', createdAt: new Date().toISOString(),
    items: [...items].map(([key, value]) => ({ key, value })) }
}
export function parseBackup(text: string): DebateRecord[] {
  if (text.length > 32_000_000) throw new Error('백업 파일이 너무 큽니다.')
  const value = JSON.parse(text)
  if (value?.format !== 'humanities-debate-backup' || value.version !== 1 || !Array.isArray(value.items) || value.items.length > 1000) throw new Error('지원하지 않는 백업 파일입니다.')
  const ids = new Set<string>()
  return value.items.map((item: { key?: unknown; value?: unknown }) => {
    if (typeof item?.key !== 'string' || !item.key.startsWith(RECORD_KEY_PREFIX) || typeof item.value !== 'string') throw new Error('토론 기록 이외의 데이터는 가져올 수 없습니다.')
    const record = parseRecord(JSON.parse(item.value))
    if (item.key !== RECORD_KEY_PREFIX + record.id || ids.has(record.id)) throw new Error('백업의 기록 ID가 중복되거나 일치하지 않습니다.')
    ids.add(record.id)
    return record
  })
}
// Copy-only, idempotent import. Preflight every conflict; never replace an existing record.
export function importRecords(storage: Store, records: DebateRecord[]) {
  const planned = records.map(record => {
    const safe = parseRecord(record), key = RECORD_KEY_PREFIX + safe.id, serialized = JSON.stringify(safe)
    const previous = storage.getItem(key)
    if (previous !== null && JSON.stringify(parseRecord(JSON.parse(previous))) !== serialized) throw new Error('같은 ID의 다른 기록이 있어 가져오기를 중단했습니다. 기존 기록과 백업을 유지했습니다.')
    return { key, serialized, previous }
  })
  const inserted: typeof planned = []
  try {
    for (const item of planned) {
      if (item.previous !== null) continue
      // A second tab may have written after preflight. Do not overwrite it.
      if (storage.getItem(item.key) !== null) throw new Error('기록이 변경되었습니다. 다시 불러온 뒤 시도해 주세요.')
      storage.setItem(item.key, item.serialized); inserted.push(item)
      if (storage.getItem(item.key) !== item.serialized) throw new Error('저장 결과를 확인하지 못했습니다.')
    }
    return { copied: inserted.length, existing: planned.length - inserted.length }
  } catch {
    let incompleteRollback = false
    for (const item of inserted.reverse()) {
      try { if (storage.getItem(item.key) === item.serialized) storage.removeItem(item.key) } catch { incompleteRollback = true }
    }
    throw new Error(incompleteRollback ? '가져오기가 중단되어 일부 복사본이 남았습니다. 원본과 백업은 그대로입니다. 다시 불러온 뒤 재시도하면 동일 기록은 중복 저장되지 않습니다.'
      : '저장하지 못해 이번 복사를 취소했습니다. 기존 기록과 백업은 유지됩니다. 저장 공간을 확인해 주세요.')
  }
}
