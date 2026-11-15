import type { Participant } from '../types/debate'
import type { Message } from '../types/debate'
import type { ReactNode } from 'react'
import { useEffect, useRef } from 'react'

type Props = { participant: Participant; message?: Message; active: boolean; preparing: boolean; speaking: boolean; hidden: boolean; liveText?: string; interimText?: string; inputStatus?: string; children?: ReactNode }

export function ParticipantRow({ participant, message, active, preparing, speaking, hidden, liveText, interimText, inputStatus, children }: Props) {
  const row = useRef<HTMLElement>(null)
  useEffect(() => {
    // Only an explicit user turn moves the viewport; AI turns never interrupt reading.
    if (speaking && row.current) {
      const bannerHeight = document.querySelector('.topic-banner')?.getBoundingClientRect().height ?? 0
      window.scrollTo({ top: Math.max(0, window.scrollY + row.current.getBoundingClientRect().top - bannerHeight - 12), behavior: 'instant' })
    }
  }, [speaking])
  return (
    <article ref={row} id={`participant-${participant.id}`} className={`participant-row ${active ? 'active' : message ? 'previous' : ''} participant-${participant.id}`} aria-label={`${participant.name} 발언`} aria-current={active ? 'true' : undefined}>
      <div className="participant-profile">
        <span className="avatar" aria-hidden="true">{participant.initials}</span>
        <div className="participant-info">
          <div className="name-line"><h3>{participant.name}</h3><span className="role-tag">{participant.role}</span></div>
          <p>{participant.description}</p>
          <span className={`speaker-status ${active ? 'current' : ''}`}>{active ? preparing ? '발언 준비 중' : '현재 발언' : '참여자'}</span>
        </div>
      </div>
      <div className="speech-area">
        <div className="speech-content" aria-live="polite" aria-atomic="true">
        {inputStatus && <p className="input-status" role="status">{inputStatus}</p>}
        {preparing ? <div className="preparing"><span className="typing-dots" aria-label="발언 준비 중">···</span><span>의견을 준비하고 있습니다</span></div>
          : speaking ? <div className="live-speech"><span className="message-label">확인된 내용 · 발언 종료 전에는 기록되지 않습니다</span><p className="message-text">{liveText || '말하거나 아래 입력창에 의견을 적어주세요.'}</p>{interimText && <p className="speech-interim"><span>인식 중 (임시 · 바뀔 수 있어요)</span> {interimText}</p>}</div>
          : hidden ? <div className="placeholder"><strong>이전 발언 숨김</strong><span>실전 모드 · 원본은 전체 대화에 보존됩니다</span></div>
          : message ? <div><span className="message-label">{active ? '지금 읽을 발언' : '이전 발언'} · {message.isUser ? '사용자 발언' : message.source === 'real' ? '실제 AI 발언' : 'Mock AI 발언'}</span><p className="message-text">{message.text}</p></div>
          : <div className="placeholder"><strong>발언 대기</strong><span>{participant.id === 'user' ? '말하기 버튼으로 내 발언을 시작해 보세요.' : '순서가 되면 이곳에 발언이 표시됩니다.'}</span></div>}
        </div>
        {children}
      </div>
    </article>
  )
}
