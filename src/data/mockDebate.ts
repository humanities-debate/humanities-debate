import type { AIId, Participant } from '../types/debate.ts'
import { decisionTopic } from './topics.ts'

export const topic = decisionTopic.title
export const participants: Participant[] = [
  { id: 'user', name: '나', initials: '나', role: '사용자', description: '나의 관점 나누기' },
  { id: 'ai1', name: '김지훈', initials: '지훈', role: 'AI 1', description: '근거와 논리 중심' },
  { id: 'ai2', name: '이서연', initials: '서연', role: 'AI 2', description: '비판적 질문과 탐색' },
  { id: 'ai3', name: '박민수', initials: '민수', role: 'AI 3', description: '의견 조율과 정리' },
]
export const aiIds: AIId[] = ['ai1', 'ai2', 'ai3']
