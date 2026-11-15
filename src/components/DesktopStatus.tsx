import { useEffect, useState } from 'react'
import type { DesktopStatus as Status } from '../desktop'

export function DesktopStatus() {
  const desktop = window.debateDesktop
  const [status, setStatus] = useState<Status>({ phase: 'starting', message: 'AI 서버 준비 중' })
  const [error, setError] = useState('')
  useEffect(() => {
    if (!desktop) return
    let active = true
    const update = (value: Status) => { if (active) setStatus(value) }
    const unsubscribe = desktop.onStatus(update)
    void desktop.status().then(update).catch(() => { if (active) setError('앱 연결 상태를 확인하지 못했습니다.') })
    return () => { active = false; unsubscribe() }
  }, [desktop])
  if (!desktop) return null
  const busy = status.phase === 'starting' || status.phase === 'logging-in'
  const act = (action: () => Promise<Status>) => { setError(''); void action().catch(() => setError('요청을 처리하지 못했습니다. 앱을 다시 실행해 주세요.')) }
  return <aside className="desktop-status" aria-label="데스크톱 앱 연결 상태">
    <strong>인문학 토론 연습 · 개인 테스트용</strong>
    <span role="status">{status.message}</span>
    <div>
      <button className="button" disabled={busy} onClick={() => {
        if (status.phase !== 'ready' || window.confirm('AI 연결을 멈추고 다시 로그인할까요? 진행 중인 AI 요청은 취소됩니다.')) act(desktop.login)
      }}>ChatGPT {status.phase === 'ready' ? '다시 로그인' : '로그인'}</button>
      {status.phase !== 'ready' && <button className="button" disabled={busy} onClick={() => act(desktop.reconnect)}>다시 연결</button>}
      {status.phase === 'logging-in' && <button className="button" onClick={() => act(desktop.cancelLogin)}>로그인 취소</button>}
    </div>
    <small>비공식 연습 앱 · 기록은 이 PC에 저장됩니다. 음성은 로컬에서 처리하며 텍스트 입력도 가능합니다.</small>
    {error && <p role="alert">{error}</p>}
  </aside>
}
