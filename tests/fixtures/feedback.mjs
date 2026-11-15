// Synthetic test data only; never a substitute for a real generated feedback response.
import { criteria } from '../../src/records/feedback.ts'
export const settings = { model: 'gpt-6.1-sol', reasoningEffort: 'medium' }
export function fixtureRecord() {
  const utterances = [
    ['ai1', '김지훈', 'AI가 채용 서류를 먼저 검토하면 많은 지원자를 같은 기준으로 볼 수 있습니다. 최종 결정은 사람이 하면 어떨까요?'],
    ['user', '나', '같은 기준을 적용하는 것과 공정한 기준인 것은 다릅니다. 과거 합격자 자료에 편향이 있다면 AI도 그 기준을 따를 수 있어요. 최종 결정만 사람이 하기보다 어떤 기준으로 탈락했는지 지원자에게 설명하는 절차가 필요합니다.'],
    ['ai2', '이서연', '설명은 필요하지만 지원자 모두에게 자세한 평가를 공개하면 평가 기준을 외워서 지원하는 문제도 생기지 않을까요?'],
    ['user', '나', '그 방법도 문제가 있다고 생각합니다. 공개하지 않으면 안 됩니다.'],
    ['ai3', '박민수', '전부 공개하기보다 탈락 이유를 큰 항목으로 알리고 이의를 제기하면 사람이 검토하는 방식은 어떨까요?'],
    ['user', '나', '탈락 이유를 항목별로 알려주는 방식이라면 기준을 외울 위험도 줄일 수 있겠네요. 세부 가중치를 모두 공개해야 한다는 제 생각은 수정하겠습니다. 다만 이의 신청을 처리할 담당자와 답변 기한도 정해야 형식적인 절차로 끝나지 않을 것 같습니다.'],
  ]
  return { schemaVersion: 1, id: 'feedback-synthetic-record', topic: { id: 'custom-test', title: '채용에서 AI의 판단을 어디까지 믿어도 될까?', source: 'custom', category: '직접 입력',
    context: { situation: '회사가 AI로 지원 서류를 검토하고 최종 합격자는 사람이 결정하려고 합니다.', keyIssue: '빠른 심사와 공정한 판단을 어떻게 함께 지킬까요?' } },
    startedAt: 1000, endedAt: 61000, durationMs: 60000, mode: 'practice', modelSettings: settings,
    messages: utterances.map(([speakerId, speakerName, text], index) => ({ id: `msg-${index + 1}`, order: index + 1, turnId: index + 1, speakerId, speakerName, isUser: speakerId === 'user', text,
      timestamp: 1000 + index * 10000, elapsedMs: index * 10000, source: speakerId === 'user' ? 'text' : 'mock' })) }
}
export function fixtureContent() {
  const evidence = [{ userId: 'msg-2', contextIds: ['msg-1'] }]
  const assessment = text => ({ text, evidence })
  return { summary: assessment('공정한 기준의 필요성을 설명했습니다. 공개 수준에는 검토할 여지가 있습니다. 입장 수정도 확인됩니다.'),
    strength: assessment('같은 기준과 공정한 기준을 구분했습니다.'), improvement: assessment('반대하는 이유를 더 구체적으로 말해 보세요.'), nextGoal: assessment('상대의 핵심 근거 하나를 짚고 답하기.'),
    categories: criteria.map((criterion, index) => ({ id: criterion.id, score: [80, 74, 83, 79, 76][index], reason: '기준의 공정성을 설명하고 공개 절차를 제안한 발언을 근거로 평가했습니다.', action: '판단 기준 뒤에 이유 한 문장을 덧붙이세요.', evidence })),
    strengths: [{ userId: 'msg-2', contextIds: ['msg-1'], reason: '같은 기준의 한계를 설명했습니다.', skill: '논리성', rewrite: null }],
    weaknesses: [{ userId: 'msg-4', contextIds: ['msg-3'], reason: '기준을 외우는 문제에 직접 답하지 않았습니다.', skill: '반박 능력', rewrite: '세부 가중치 대신 큰 항목만 공개하면 외워서 지원하는 문제를 줄일 수 있겠습니다.' }],
    nextActions: [assessment('반박할 때 상대의 핵심 근거 하나를 먼저 짚으세요.'), assessment('대안을 낼 때 실행 주체를 한 문장으로 설명하세요.')] }
}
export function fixtureFeedback() {
  return { ...fixtureContent(), schemaVersion: 1, recordId: fixtureRecord().id, analyzedAt: 62000, modelSettings: settings }
}
