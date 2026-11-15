import { useState } from 'react'
import type { TopicContext } from '../types/debate'

export function TopicExplanation({ context, collapsible = false, initiallyOpen = false }: { context?: TopicContext; collapsible?: boolean; initiallyOpen?: boolean }) {
  // The live banner is keyed by session ID. Only a new discussion resets this choice.
  const [open, setOpen] = useState(initiallyOpen)
  const situation = context?.situation?.trim()
  const keyIssue = context?.keyIssue?.trim()
  if (!situation && !keyIssue) return null
  const content = <div className="topic-explanation">
    {situation && <p><strong className="topic-context-label">상황 <small>(가상 예시)</small></strong>{situation}</p>}
    {keyIssue && <p className="topic-key-issue"><strong className="topic-context-label">쟁점</strong>{keyIssue}</p>}
  </div>
  return collapsible ? <details className="topic-explanation-toggle" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{situation ? keyIssue ? '상황과 쟁점' : '상황' : '쟁점'} {open ? '접기' : '펼치기'}</summary>
    {content}
  </details> : content
}
