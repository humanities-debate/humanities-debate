import { participants } from '../data/mockDebate.ts'
import { mockOpenings, mockReactions, mockResponses } from '../data/mockDialogue.ts'
import type { DiscussionPoint } from '../data/mockDialogue.ts'
import type { AIRequest } from '../types/debate.ts'
import type { AIProvider } from './AIProvider.ts'
import { decisionTopic } from '../data/topics.ts'
import { createTopicMockReply } from './topicMock.ts'

function excerpt(text: string) {
  const plain = text.replace(/\s+/g, ' ').trim()
  return plain.length > 100 ? plain.slice(0, 100) + '…' : plain
}
function discussionPoint(text: string): DiscussionPoint {
  if (/공정|차별|집단|소수|편향/.test(text)) return 'fairness'
  if (/책임|승인|권한|인간|사람/.test(text)) return 'responsibility'
  if (/검토|설명|이의|되돌|구제/.test(text)) return 'review'
  if (/정확|오류|데이터|검증|속도|빠르/.test(text)) return 'accuracy'
  return 'general'
}

export function createMockReply(request: AIRequest): string {
  if (request.topicDetails.source !== 'prepared' || request.topicDetails.id !== decisionTopic.id) return createTopicMockReply(request)
  const previous = request.history.at(-1)
  const ownTurns = request.history.filter((message) => message.speakerId === request.speakerId).length
  const id = request.persona.id
  if (!previous) return mockOpenings[id]

  // Quote actual user input. For AI turns, use the last substantive sentence to avoid
  // recursively quoting earlier quotations. Keyword routing is a mock, not understanding.
  const focus = previous.isUser ? previous.text : (previous.text.match(/[^.!?]+[.!?]?/g)?.at(-1)?.trim() ?? previous.text)
  const name = (participants.find((participant) => participant.id === previous.speakerId)?.name ?? '앞선 참가자') + ' 님'
  const template = mockReactions[id][ownTurns % mockReactions[id].length]
  const addressed = previous.isUser
    ? template.replace('{name}, ', '').replace('{name}. ', '')
    : template.replace('{name}', name)
  const reaction = addressed.replace('{quote}', () => excerpt(focus))
  const answers = mockResponses[id][discussionPoint(focus)]
  const response = answers[ownTurns % answers.length]
  const question = /[?？]/.test(focus)
    ? { ai1: '질문에 답을 드리면, ', ai2: '그 질문에는 이렇게 답하고 싶어요. ', ai3: '그 부분은 이렇게 풀어보면 어떨까요? ' }[id]
    : ''
  return reaction + ' ' + question + response
}

export const mockAIProvider: AIProvider = {
  async generateReply(request, signal) {
    signal.throwIfAborted()
    return { text: createMockReply(request) }
  },
}
