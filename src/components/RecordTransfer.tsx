import { useState } from 'react'
import type { DebateRecord } from '../records/record'
import { backupRecords, importRecords, parseBackup } from '../records/transfer'

export function RecordTransfer({ pending, onReload }: { pending: DebateRecord[]; onReload: () => void }) {
  const [records, setRecords] = useState<DebateRecord[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  function download() {
    try {
      const blob = new Blob([JSON.stringify(backupRecords(window.localStorage, pending), null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob), anchor = document.createElement('a')
      anchor.href = url; anchor.download = `humanities-debate-backup-${new Date().toISOString().slice(0, 10)}.json`; anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setMessage('백업 파일 저장을 요청했습니다. 다운로드 폴더에서 확인하세요. 원본은 유지됩니다.')
    } catch { setMessage('백업하지 못했습니다. 원본은 유지됩니다. 브라우저 저장 권한을 확인해 주세요.') }
  }
  async function read(file?: File) {
    if (!file || busy) return
    setBusy(true); setSelected([]); setRecords([])
    try {
      if (file.size > 32_000_000) throw new Error('파일이 너무 큽니다.')
      const parsed = parseBackup(await file.text()); setRecords(parsed)
      setMessage(`${parsed.length}개 기록을 확인했습니다. 본인의 기록만 선택해 현재 계정에 복사하세요.`)
    } catch { setMessage('백업 파일의 기록·발언·분석 형식을 확인하지 못했습니다. 원본 파일과 기존 기록은 변경하지 않았습니다.') }
    finally { setBusy(false) }
  }
  function copy() {
    if (busy || !selected.length || !window.confirm('선택한 기록이 본인의 기록임을 확인하고, 현재 로그인한 계정의 저장소에 복사할까요? 기존 기록과 백업 파일은 삭제하지 않습니다.')) return
    setBusy(true)
    try {
      const result = importRecords(window.localStorage, records.filter(record => selected.includes(record.id)))
      setMessage(`${result.copied}개 복사, ${result.existing}개 동일 기록 유지. 원문과 분석을 보존했습니다.`)
      setSelected([]); onReload()
    } catch (error) { setMessage(error instanceof Error ? error.message : '가져오지 못했습니다. 백업은 유지됩니다.'); onReload() }
    finally { setBusy(false) }
  }
  return <details id="record-transfer" className="history-panel"><summary>기록 백업·가져오기</summary>
    <p className="muted">AI 호출 없이 PC에서 처리합니다. 백업에는 개인 발언이 포함됩니다. 개발자나 외부에 보내지 마세요. 이전 기록의 소유자는 자동 확인할 수 없습니다.</p>
    <div className="record-actions"><button className="button" onClick={download} disabled={busy}>기록 백업 저장</button>
      <label className="button">백업 파일 선택 <input type="file" accept="application/json,.json" disabled={busy} onChange={event => { void read(event.target.files?.[0]); event.target.value = '' }} /></label></div>
    {records.length > 0 && <><ul className="records-list">{records.map(record => <li key={record.id}><label><input type="checkbox" checked={selected.includes(record.id)} onChange={event => setSelected(previous => event.target.checked ? [...previous, record.id] : previous.filter(id => id !== record.id))} /> {record.topic.title} · {new Date(record.startedAt).toLocaleDateString('ko-KR')} · {record.messages.length}개 발언</label></li>)}</ul>
      <button className="button" disabled={busy || !selected.length} onClick={copy}>선택한 내 기록 {selected.length}개 복사</button></>}
    <p role="status">{message}</p>
  </details>
}
