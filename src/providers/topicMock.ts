import { participants } from '../data/mockDebate.ts'
import type { AIId, AIRequest } from '../types/debate.ts'

const questions: Record<AIId, readonly string[]> = {
  ai1: ['두 선택을 비교할 기준과 그 기준을 뒷받침할 사례를 먼저 정하면 좋겠습니다.', '이 기준을 적용하기 어려운 예외도 확인해야 합니다. 어느 범위까지 같은 원칙을 적용할 수 있겠습니까?'],
  ai2: ['근데 반대 선택을 했을 때 얻는 것도 있지 않을까요? 포기하게 되는 가치를 같이 따져보고 싶어요.', '그렇긴 한데 부담이 특정 사람에게만 몰리지는 않을까요? 그 경우에도 같은 선택을 할 수 있을지 궁금해요.'],
  ai3: ['그러면 각 선택이 지키려는 가치를 하나씩 짚어보면 어떨까요? 공통으로 지킬 조건부터 찾아보고 싶어요.', '아, 한쪽을 무조건 고르기보다 상황에 따라 기준을 나눌 수도 있겠네요. 다만 그 경계를 어떻게 정할지도 이야기하면 좋겠어요.'],
}

// Prepared topic notes and generic questions only: no interpretation of arbitrary input.
export function createTopicMockReply(request: AIRequest): string {
  const id = request.speakerId
  const ownTurns = request.history.filter(message => message.speakerId === id).length
  const previous = request.history.at(-1)
  let context = ''
  if (previous) {
    const text = previous.isUser ? previous.text : (previous.text.match(/[^.!?]+[.!?]?/g)?.at(-1) ?? previous.text)
    const plain = text.replace(/\s+/g, ' ').trim()
    const quote = plain.length > 100 ? plain.slice(0, 100) + '…' : plain
    const name = previous.isUser ? '사용자' : participants.find(person => person.id === previous.speakerId)?.name ?? '앞선 참가자'
    context = {
      ai1: `${name}님의 “${quote}”라는 발언을 토론의 검토 항목으로 두겠습니다. `,
      ai2: `${name}님이 “${quote}”라고 말씀하셨는데, 다른 관점에서도 살펴보고 싶어요. `,
      ai3: `${name}님의 “${quote}”라는 말씀도 함께 놓고 이야기해 보면 좋겠어요. `,
    }[id]
  }
  const topic = request.topicDetails
  const label = topic.source === 'custom' ? '범용 연습 질문' : '미리 작성한 예시 논점'
  const point = topic.source === 'prepared' && ownTurns % 3 === 0
    ? topic.mockPoints?.[{ ai1: 0, ai2: 1, ai3: 2 }[id]]
    : undefined
  return `“${request.topic}” · ${label}\n${context}${point ?? questions[id][ownTurns % questions[id].length]}`
}
