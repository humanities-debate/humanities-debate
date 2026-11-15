import { useState } from 'react'
import type { DebateRecord } from '../records/record'
import { formatDuration, recordText, userMessages } from '../records/record'
import type { RecordEntry } from '../records/library'
import { TopicExplanation } from './TopicExplanation'
import { FeedbackPanel } from './FeedbackPanel'
import type { Feedback } from '../records/feedback'
import type { ModelCatalog } from '../types/debate'
import { presetLabel } from '../config/aiPresets'
import { RecordTransfer } from './RecordTransfer'

type Actions = { onOpen: (id: string) => void; onDelete: (id: string) => void; onRetry: (id: string) => void }
function SaveStatus({ entry, onRetry }: { entry?: RecordEntry; onRetry: (id: string) => void }) {
  return <div className="record-save-status">
    <p>{entry ? entry.saved ? '이 브라우저에 저장됨' : '미저장 · 현재 페이지에 보관 중' : '기록 저장 중'}</p>
    {entry?.error && <p role="alert">{entry.error}</p>}
    {entry && !entry.saved && <button className="button" onClick={() => onRetry(entry.record.id)}>다시 저장</button>}
  </div>
}

export function RecordLibrary({ entries, loadError, onOpen, onDelete, onRetry, onReload }: Actions & {
  entries: RecordEntry[]; loadError: string | null; onReload: () => void
}) {
  return <section className="records-panel" aria-labelledby="records-heading">
    <div className="section-heading"><h2 id="records-heading">과거 토론 기록</h2><button className="button" onClick={onReload}>다시 불러오기</button></div>
    <p className="muted">이 브라우저에만 저장됩니다. 기록을 열거나 복사해도 AI를 호출하지 않습니다.</p>
    <RecordTransfer pending={entries.filter(entry => !entry.saved).map(entry => entry.record)} onReload={onReload} />
    {loadError && <p className="record-error" role="alert">{loadError}</p>}
    {!entries.length && <p className="empty-history">아직 저장된 토론이 없습니다.</p>}
    <ul className="records-list">{entries.map(entry => <li key={entry.record.id}>
      <h3>{entry.record.topic.title}</h3>
      <p className="muted">{new Date(entry.record.startedAt).toLocaleString('ko-KR')} · {formatDuration(entry.record.durationMs)} · 전체 {entry.record.messages.length}회 / 내 발언 {userMessages(entry.record).length}회</p>
      <SaveStatus entry={entry} onRetry={onRetry} />
      <div className="record-actions"><button className="button" onClick={() => onOpen(entry.record.id)}>기록 열기</button><button className="button" onClick={() => onDelete(entry.record.id)}>삭제</button></div>
    </li>)}</ul>
  </section>
}

export function DebateResult({ record, entry, onRetry, onDelete, onNew, onRepeat, onLibrary, catalog, reloadModels, onFeedback }: {
  record: DebateRecord; entry?: RecordEntry; onRetry: (id: string) => void; onDelete: (id: string) => void
  onNew: () => void; onRepeat: () => void; onLibrary: () => void
  catalog: ModelCatalog | null; reloadModels: () => void; onFeedback: (feedback: Feedback, previous?: Feedback) => void
}) {
  const [copyMessage, setCopyMessage] = useState('')
  async function copy(text: string, label: string) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(text)
      setCopyMessage(`${label}을 복사했습니다.`)
    } catch { setCopyMessage('복사하지 못했습니다. 발언을 마우스로 선택한 뒤 Ctrl+C로 복사해 주세요.') }
  }
  return <section className="records-panel" aria-labelledby="result-heading">
    <p className="eyebrow">토론 결과 · 전체 기록</p>
    <h2 id="result-heading">{record.topic.title}</h2>
    <TopicExplanation context={record.topic.context} />
    <dl className="result-summary">
      <div><dt>토론 날짜</dt><dd>{new Date(record.startedAt).toLocaleString('ko-KR')}</dd></div>
      <div><dt>총 토론 시간</dt><dd>{formatDuration(record.durationMs)}</dd></div>
      <div><dt>전체 발언</dt><dd>{record.messages.length}회</dd></div>
      <div><dt>내 발언</dt><dd>{userMessages(record).length}회</dd></div>
    </dl>
    <p className="muted">시간은 일시정지를 제외합니다. 숨겨졌던 발언도 원문으로 표시합니다.</p>
    {record.modelSettings && <details className="muted"><summary>토론 AI 수준: {presetLabel(record.modelSettings)}</summary><p>세션 요청 모델: {record.modelSettings.model} · {record.modelSettings.reasoningEffort.toUpperCase()} (각 발언의 실제 AI / Mock 구분은 아래 표시)</p></details>}
    <SaveStatus entry={entry} onRetry={onRetry} />
    <div className="record-actions">
      <button className="button speak-button" onClick={onNew}>새 토론 시작</button>
      <button className="button" onClick={onRepeat}>같은 주제로 다시 연습</button>
      <button className="button" onClick={onLibrary}>과거 토론 보기</button>
      <button className="button" onClick={() => void copy(recordText(record), '전체 기록')}>전체 기록 복사</button>
      <button className="button" onClick={() => onDelete(record.id)} disabled={!entry}>이 기록 삭제</button>
    </div>
    <p className="small-label">새 토론과 다시 연습은 설정 화면에서 주제·모델을 확인한 뒤 시작합니다.</p>
    <p role="status" className="copy-status">{copyMessage}</p>
    <FeedbackPanel record={record} catalog={catalog} reloadModels={reloadModels} onSave={onFeedback} />
    <h3>전체 발언 기록</h3>
    {!record.messages.length && <p className="empty-history">확정된 발언 없이 종료한 토론입니다.</p>}
    <ol className="result-transcript">{record.messages.map(message => <li key={message.id} className={message.isUser ? 'user-message' : ''}>
      <div className="history-meta"><strong>{message.order}. {message.speakerName}</strong><span>{message.isUser ? '사용자' : message.source === 'real' ? '실제 AI' : 'Mock AI'} · 경과 {formatDuration(message.elapsedMs)} · {message.id}</span>
        <button className="button copy-button" onClick={() => void copy(message.text, `${message.order}번 발언`)}>발언 복사</button></div>
      <p>{message.text}</p>
    </li>)}</ol>
  </section>
}
