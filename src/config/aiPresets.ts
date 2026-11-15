import type { ModelChoice, ModelSettings } from '../types/debate.ts'

export type PresetPurpose = 'debate' | 'feedback'
export type PresetId = 'debate-standard' | 'debate-advanced' | 'feedback-standard' | 'feedback-deep'
export type PresetSelection = PresetId | 'custom'
// Single source for UI, server validation, SDK settings and prompt guidance.
// Availability is checked against the signed-in account catalog; never substitute a model.
export const aiPresets = [
  { id: 'debate-standard', purpose: 'debate', label: '일반 토론',
    description: '자연스러운 대화와 적절한 반박. 사용량을 절약하며 반복 연습하기 좋습니다.',
    model: 'gpt-6-luna', reasoningEffort: 'medium',
    instruction: '일반 토론 연습입니다. 이해하기 쉬운 이유로 논의를 이어가세요. 지금 필요한 것이 반론인지, 내 생각을 더 설명하는 것인지, 남은 선택을 다루는 것인지 내용에 맞게 판단하세요. 불필요하게 복잡한 분석을 늘리지 마세요.' },
  { id: 'debate-advanced', purpose: 'debate', label: '심화 토론',
    description: '더 깊이 있는 논리 전개와 까다로운 반론. 사용량이 더 늘어날 수 있습니다.',
    model: 'gpt-6.1-sol', reasoningEffort: 'high',
    instruction: '심화 토론 연습입니다. 숨은 전제나 반론의 타당성, 선택의 결과 중 지금 중요한 문제를 더 깊게 검토하세요. 차이가 있다면 쉬운 말로 분명히 설명하되, 심화라는 이유로 발언을 늘리거나 억지로 반대하지 마세요.' },
  { id: 'feedback-standard', purpose: 'feedback', label: '일반 분석',
    description: '100점 만점 평가와 주요 강점, 개선할 발언을 빠르게 분석합니다.',
    model: 'gpt-6-luna', reasoningEffort: 'high',
    instruction: '일반 분석입니다. 동일한 100점 기준과 모든 결과 항목을 유지하면서 실제 근거가 뚜렷한 강점·개선점을 간결하고 실용적으로 설명하세요. 분석 수준을 이유로 항목을 생략하거나 근거 검증을 줄이지 마세요. evidenceIndex.userIds에서 userId를 고르고, contextIds는 evidenceIndex.aiIds 중 해당 사용자 발언보다 먼저 나온 ID만 고르세요. 점수를 매긴 항목에는 evidence가 필요합니다. 점수가 하나라도 있으면 summary, strength, improvement, nextGoal, nextActions 각각에도 근거 evidence를 연결하세요. 반환 전에 모든 참조의 역할과 순서를 확인하세요.' },
  { id: 'feedback-deep', purpose: 'feedback', label: '심층 분석',
    description: '토론 전체 맥락과 반박의 타당성을 더 깊이 검토하고 개선 전략을 제시합니다.',
    model: 'gpt-6.1-sol', reasoningEffort: 'high',
    instruction: '심층 분석입니다. 전체 흐름에서 논리적 비약과 주장의 타당성, 상대 근거에 대한 반박의 정확성, 놓친 반박 기회·논점, 논의 기여를 더 깊게 검토하세요. 놓친 기회는 실제 사용자 발언과 그 이전 AI 발언 ID로 입증할 수 있을 때만 조언으로 설명하고 하지 않은 발언을 했다고 평가하지 마세요. 기존 결과 항목 안에서 구체적인 개선 전략을 제시하세요. 일반 분석과 동일한 100점 평가 기준을 사용하며 심층이라는 이유로 점수나 채점 엄격도를 바꾸지 마세요.' },
] as const
export function presetSettings(id: PresetId): ModelSettings {
  const preset = aiPresets.find(item => item.id === id)!
  return { model: preset.model, reasoningEffort: preset.reasoningEffort, preset: preset.id }
}
export const defaultPreset = (purpose: PresetPurpose): PresetId => purpose === 'debate' ? 'debate-standard' : 'feedback-standard'
export function parsePreset(value: unknown, purpose?: PresetPurpose): PresetSelection | undefined {
  if (value === undefined) return undefined // Legacy records and requests remain readable.
  if (value === 'custom') return value
  const found = aiPresets.find(item => item.id === value && (!purpose || item.purpose === purpose))
  if (!found) throw new Error('지원하지 않는 연습 수준입니다.')
  return found.id
}
export function settingsAvailable(settings: ModelSettings | null, models?: ModelChoice[]): boolean {
  return Boolean(settings && models?.some(model => model.model === settings.model && model.reasoningEfforts.includes(settings.reasoningEffort)))
}
export function presetMatches(settings: ModelSettings, purpose?: PresetPurpose): boolean {
  try {
    const id = parsePreset(settings.preset, purpose)
    if (!id || id === 'custom') return true
    const preset = presetSettings(id)
    return preset.model === settings.model && preset.reasoningEffort === settings.reasoningEffort
  } catch { return false }
}
export function presetLabel(settings: ModelSettings | null | undefined) {
  if (!settings?.preset) return '기존 수동 설정'
  return settings.preset === 'custom' ? '고급 수동 설정' : aiPresets.find(item => item.id === settings.preset)?.label ?? '알 수 없는 설정'
}
export function presetInstruction(settings: ModelSettings | undefined, purpose: PresetPurpose) {
  return aiPresets.find(item => item.id === settings?.preset && item.purpose === purpose)?.instruction ?? ''
}
