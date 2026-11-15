import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { DebateState } from '../logic/debate'
import { completedRecord } from '../records/record'
import { createRecordLibrary } from '../records/library'
import { createLocalRecordRepository, RECORD_KEY_PREFIX } from '../records/repository'

export function useRecords(state: DebateState) {
  const [runId] = useState(() => crypto.randomUUID())
  const [library] = useState(() => createRecordLibrary(createLocalRecordRepository()))
  const snapshot = useSyncExternalStore(library.subscribe, library.getSnapshot)
  const currentRecord = useMemo(() => completedRecord(state, `${runId}-${state.sessionId}`), [state, runId])
  useEffect(() => { if (currentRecord) library.capture(currentRecord) }, [currentRecord, library])
  useEffect(() => {
    const refresh = (event: StorageEvent) => { if (event.key === null || event.key.startsWith(RECORD_KEY_PREFIX)) library.refresh() }
    const warn = (event: BeforeUnloadEvent) => {
      if (library.getSnapshot().entries.some(entry => !entry.saved)) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('storage', refresh)
    window.addEventListener('beforeunload', warn)
    return () => { window.removeEventListener('storage', refresh); window.removeEventListener('beforeunload', warn) }
  }, [library])
  return { ...snapshot, library, currentRecord }
}
