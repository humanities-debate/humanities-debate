import { MAX_INPUT_LENGTH } from '../logic/debate'
import type { SpeechSnapshot } from '../speech/types'
import { speechBusy } from '../speech/types'
import { endMarkerEdit } from '../speech/endMarker'

type Props = {
  draft: string
  paused: boolean
  speech: SpeechSnapshot
  supported: boolean
  onChange: (text: string) => void
  onSubmit: () => void
  onCancel: () => void
  onStartVoice: () => void
  onStopVoice: (intent: 'submit' | 'review') => void
}

export function UserInput({ draft, paused, speech, supported, onChange, onSubmit, onCancel, onStartVoice, onStopVoice }: Props) {
  const busy = speechBusy(speech.phase)
  const stopping = speech.phase === 'stopping'
  const withoutEndMarker = window.debateDesktop && speech.phase === 'review' ? endMarkerEdit(draft, speech.finalText) : null
  return (
    <form className="user-input-panel" onSubmit={(event) => {
      event.preventDefault()
      if (paused || stopping) return
      if (busy) onStopVoice('submit')
      else if (draft.trim()) onSubmit()
    }}>
      {busy ? <strong>발언 마무리</strong> : <label htmlFor="user-input">내 발언 확인·수정</label>}
      <p id="input-help">{busy
        ? window.debateDesktop ? '음성은 PC에서만 처리합니다. 임시 자막은 처리 속도에 따라 지연될 수 있습니다. 종료 후 최종 결과를 확인·수정하고 발언 완료를 눌러주세요. 처리 중에도 AI는 기다립니다.'
          : '임시 문장은 위의 내 발언 영역에서 확인하세요. 수정하려면 먼저 인식을 멈춰주세요.'
        : '내용을 확인하고 수정할 수 있습니다. 발언 완료를 누르기 전까지 AI는 기다립니다.'}</p>
      {!busy && <textarea id="user-input" value={draft} onChange={(event) => onChange(event.target.value)}
        autoFocus disabled={paused} maxLength={MAX_INPUT_LENGTH} rows={3}
        aria-describedby="input-help input-count" placeholder="마이크로 말하거나 토론 주제에 대한 생각과 근거를 적어보세요." />}
      {speech.interimText && !busy && <p className="speech-interim">미확정 문장 (자동 저장 제외): {speech.interimText}</p>}
      {speech.recoveryText && <p className="speech-interim">이전 인식의 미확정 문장 (자동 저장 제외 · 필요한 내용은 직접 편집해 주세요): {speech.recoveryText}</p>}
      {speech.overflowText && <p className="speech-interim">4,000자 초과분 (기록 제외 · 필요한 내용을 복사해 두세요): {speech.overflowText}</p>}
      {speech.phase === 'error' && speech.diagnostics?.length ? <details>
        <summary>음성 인식 진단 · {speech.errorCode ?? 'recognition-error'}</summary>
        <p>연결·종료 순서만 표시합니다. 음성 내용과 계정 정보는 포함하지 않으며 저장·전송하지 않습니다.</p>
        <ol>{speech.diagnostics.map((entry, index) => <li key={index}>
          {(entry.elapsedMs / 1000).toFixed(1)}초 · 연결 {entry.attempt} · {entry.event}{entry.code ? ' · ' + entry.code : ''}
        </li>)}</ol>
      </details> : null}
      <div className="user-input-actions">
        <span id="input-count">{draft.length} / {MAX_INPUT_LENGTH}자{!draft.trim() && !busy ? ' · 내용을 입력해 주세요' : ''}</span>
        {busy
          ? <button className="button" type="button" disabled={paused || stopping} onClick={() => onStopVoice('review')}>멈추고 수정</button>
          : <button className="button" type="button" disabled={paused || !supported} onClick={onStartVoice}>마이크 다시 켜기</button>}
        <button className="button" type="button" disabled={paused} onClick={onCancel}>입력 취소</button>
        {withoutEndMarker !== null && <button className="button" type="button" disabled={paused} onClick={() => onChange(withoutEndMarker)}>말하지 않은 ‘(끝)’ 지우기</button>}
        <button className="button speak-button" type="submit" disabled={paused || stopping || (!busy && !draft.trim())}>{stopping ? '마지막 결과 확인 중' : busy ? '발언 종료' : '발언 완료'}</button>
      </div>
    </form>
  )
}
