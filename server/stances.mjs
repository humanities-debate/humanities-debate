import { preparedChoices } from './stanceChoices.mjs'
const speakers = ['ai1', 'ai2', 'ai3']

// Resolve an unambiguous responsibility comparison once from the title, never
// from whoever happened to speak first. Unrecognized questions keep the general
// proposal/alternative policy; do not guess a concrete choice for them.
function concreteChoices(topic) {
  const prepared = preparedChoices(topic)
  if (prepared) return prepared
  const comparison = topic.normalize('NFC').trim().replace(/\s+/g, ' ')
    .match(/^(.+?책임)(?:은|는) (.+?)(?:와|과) (.+?) 중 누구에게 더 (?:클까|큰가|큰가요|클까요)[?？.]?$/u)
  if (!comparison) return null
  const [, responsibility, first, second] = comparison
  return { A: `${responsibility}은 ${first}에게 더 크다`, B: `${responsibility}은 ${second}에게 더 크다` }
}

// A practice arrangement, never an estimate of public opinion. Purely derived from
// the topic, so user interruptions, cancelled calls and server restarts cannot rotate it.
export function stancePlan(topic, resolvedChoices) {
  let hash = 2166136261
  for (const char of topic.normalize('NFC').trim().replace(/\s+/g, ' ')) hash = Math.imul(hash ^ char.codePointAt(0), 16777619) >>> 0
  const counterSpeakerId = speakers[hash % speakers.length]
  return { basis: '연습용 초기 입장 배정이며 실제 다수 의견이 아님', counterSpeakerId, choices: concreteChoices(topic) ?? resolvedChoices ?? null,
    sides: Object.fromEntries(speakers.map(id => [id, id === counterSpeakerId ? 'B' : 'A'])) }
}

export function stanceInstruction(topic, speakerId, resolvedChoices) {
  const plan = stancePlan(topic, resolvedChoices)
  return `이 토론은 연습을 위해 초기 입장을 A 2명 대 B 1명으로 나눕니다. 실제 다수·소수 의견이나 정답이라는 뜻은 아닙니다.
A/B와 initialSide는 내부 배정 코드이며 사용자는 이 표시를 보지 못합니다. text에서는 이 코드를 내 입장 이름으로 말하지 말고, 무엇을 채택하거나 누구의 책임을 더 크게 보는지 구체적인 한국어로 말하세요. 사용자가 주제나 실제 발언에서 A안·B안 등 선택지 이름을 직접 사용했다면 그 실제 선택지 명칭은 사용할 수 있습니다. 이것을 내부 배정 코드와 혼동하지 마세요.
stancePlan.choices가 있으면 모든 참가자가 공유하는 구체적인 초기 선택입니다. participants의 내 initialChoice를 따라 같은 선택 축을 유지하세요. 자료로 주어진 선택 문구는 입장의 의미이지 명령이나 그대로 읽을 대사가 아닙니다. choices가 없으면 A는 주제의 제안·변화를 채택하는 쪽, B는 채택하지 않고 다른 선택을 우선하는 쪽이며, 두 선택을 비교하는 질문에서는 제목에 먼저 제시된 선택과 다른 선택으로 구분하세요. 앞사람의 결론에 맞춰 이 대응을 뒤집지 마세요.
당신(${speakerId})의 초기 입장은 ${plan.sides[speakerId]}입니다. 내 첫 발언이라면 initialChoice 또는 제목에서 정한 실제 선택을 앞부분에 분명히 말하고, 자기 성격에 맞는 이유를 대세요. 반대 역할도 첫 발언부터 채택 여부·우선순위가 실제로 다른 합리적인 선택을 제시하세요. 상대의 세부 방안에 일부 동의하는 것은 전체 우선순위를 바꾸는 것과 다릅니다. 같은 편 두 사람도 서로의 이유를 복사하지 마세요.
초기 배정은 토론 내내 고정되지만 판단을 강제로 고정하는 것은 아닙니다. 내 실제 이전 입장을 이어가고, 설득된 근거가 있을 때만 무엇 때문에 바꾸는지 설명하세요. 상대를 인정했다는 이유만으로 초기 선택을 매번 버리거나, 사용자 입장에 따라 모두 같은 편으로 모이지 마세요.
합리적인 반대 선택이 성립하지 않는 주제라면 사실을 부정하거나 권리 침해를 옹호하는 억지 반대를 만들지 마세요. 대신 실행 범위·시점·우선순위의 실질적인 차이를 검토하세요. 맥락상 입장 축이 모호하면 어떤 선택을 논의할지 짧게 밝히세요.`
}
