import type { DebateRecord } from './record.ts'
import type { ModelSettings } from '../types/debate.ts'
import { parsePreset } from '../config/aiPresets.ts'

export const criteria = [
  { id: 'logic', label: '논리성' }, { id: 'rebuttal', label: '반박 능력' },
  { id: 'interaction', label: '경청 및 상호작용' }, { id: 'contribution', label: '토론 기여도' },
  { id: 'expression', label: '표현력' },
] as const
export type CriterionId = typeof criteria[number]['id']
export type Evidence = { userId: string; contextIds: string[] }
export type Assessment = { text: string; evidence: Evidence[] }
export type Category = { id: CriterionId; score: number | null; reason: string; action: string; evidence: Evidence[] }
export type Example = Evidence & { reason: string; skill: string; rewrite: string | null }
export type FeedbackContent = {
  summary: Assessment; strength: Assessment; improvement: Assessment; nextGoal: Assessment
  categories: Category[]; strengths: Example[]; weaknesses: Example[]; nextActions: Assessment[]
}
export type Feedback = FeedbackContent & {
  schemaVersion: 1; recordId: string; analyzedAt: number; modelSettings: ModelSettings
}
export class FeedbackValidationError extends Error {
  code: 'INVALID_FEEDBACK' | 'INVALID_EVIDENCE'
  constructor(code: 'INVALID_FEEDBACK' | 'INVALID_EVIDENCE' = 'INVALID_FEEDBACK') {
    super(code === 'INVALID_EVIDENCE' ? '분석 근거가 실제 발언 ID·참가자·순서와 맞지 않습니다.' : '피드백 형식이나 점수가 올바르지 않습니다.')
    this.code = code
  }
}
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new FeedbackValidationError()
  return raw as Record<string, unknown>
}
function text(raw: unknown, max = 1500): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > max) throw new FeedbackValidationError()
  return raw
}
function list(raw: unknown, min: number, max: number): unknown[] {
  if (!Array.isArray(raw) || raw.length < min || raw.length > max) throw new FeedbackValidationError()
  return raw
}
// A conservative practice-app threshold, not an official assessment rule.
export function insufficientEvidence(record: DebateRecord): string | null {
  const messages = record.messages.filter(message => message.isUser)
  if (!messages.length) return '평가 보류: 확정된 사용자 발언이 없습니다.'
  if (messages.length < 2 || messages.reduce((sum, m) => sum + m.text.replace(/\s/g, '').length, 0) < 80)
    return '평가 보류: 사용자 발언이 너무 적거나 짧습니다. 이 앱은 사용자 발언 2회 이상·공백 제외 총 80자 이상부터 분석하며, 항목별 근거가 부족하면 추가로 보류합니다.'
  return null
}
export function scoreSummary(categories: Category[]) {
  const scores = categories.flatMap(category => category.score === null ? [] : [category.score])
  return { score: scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : null, count: scores.length }
}
export function scoreBand(score: number) {
  return score >= 90 ? '매우 우수' : score >= 80 ? '우수' : score >= 70 ? '양호' : score >= 60 ? '개선 필요' : '집중 개선 필요'
}
export function validateFeedbackContent(raw: unknown, record: DebateRecord): FeedbackContent {
  const input = object(raw)
  const messages = new Map(record.messages.map(message => [message.id, message]))
  function evidence(value: unknown): Evidence {
    const ref = object(value)
    const userId = text(ref.userId, 100)
    const user = messages.get(userId)
    const contextIds = list(ref.contextIds, 0, 8).map(id => text(id, 100))
    if (!user?.isUser || new Set(contextIds).size !== contextIds.length || contextIds.some(id => {
      const context = messages.get(id)
      return !context || context.isUser || context.order >= user.order
    })) throw new FeedbackValidationError('INVALID_EVIDENCE')
    return { userId, contextIds }
  }
  const evidenceList = (value: unknown) => {
    const refs = list(value, 0, 12).map(evidence)
    if (new Set(refs.map(ref => ref.userId)).size !== refs.length) throw new FeedbackValidationError('INVALID_EVIDENCE')
    return refs
  }
  function assessment(value: unknown): Assessment {
    const item = object(value)
    return { text: text(item.text), evidence: evidenceList(item.evidence) }
  }
  const categories = list(input.categories, 5, 5).map((value, index): Category => {
    const item = object(value)
    const id = criteria[index].id
    if (item.id !== id || (item.score !== null && (typeof item.score !== 'number' || !Number.isInteger(item.score) || item.score < 0 || item.score > 100))) throw new FeedbackValidationError()
    const refs = evidenceList(item.evidence)
    if (item.score !== null && (!refs.length || insufficientEvidence(record) ||
      (['rebuttal', 'interaction'].includes(id) && !refs.some(ref => ref.contextIds.length)))) throw new FeedbackValidationError('INVALID_EVIDENCE')
    return { id, score: item.score as number | null, reason: text(item.reason), action: text(item.action, 600), evidence: refs }
  })
  function examples(value: unknown, weak: boolean): Example[] {
    const items = list(value, 0, 3).map(value => {
      const item = object(value)
      if (!weak && item.rewrite !== null) throw new FeedbackValidationError()
      return { ...evidence(item), reason: text(item.reason), skill: text(item.skill, 200), rewrite: weak ? text(item.rewrite, 1600) : null }
    })
    if (new Set(items.map(item => item.userId)).size !== items.length) throw new FeedbackValidationError('INVALID_EVIDENCE')
    return items
  }
  const result = { summary: assessment(input.summary), strength: assessment(input.strength), improvement: assessment(input.improvement), nextGoal: assessment(input.nextGoal),
    categories, strengths: examples(input.strengths, false), weaknesses: examples(input.weaknesses, true), nextActions: list(input.nextActions, 2, 3).map(assessment) }
  if (categories.some(category => category.score !== null) && [result.summary, result.strength, result.improvement, result.nextGoal, ...result.nextActions].some(item => !item.evidence.length)) throw new FeedbackValidationError('INVALID_EVIDENCE')
  return result
}
export function parseFeedback(raw: unknown, record: DebateRecord): Feedback {
  const input = object(raw)
  const settings = object(input.modelSettings)
  if (input.schemaVersion !== 1 || input.recordId !== record.id || typeof input.analyzedAt !== 'number' || !Number.isSafeInteger(input.analyzedAt) || input.analyzedAt < record.endedAt ||
    !['low', 'medium', 'high'].includes(String(settings.reasoningEffort))) throw new FeedbackValidationError()
  const preset = parsePreset(settings.preset, 'feedback')
  return { ...validateFeedbackContent(input, record), schemaVersion: 1, recordId: record.id, analyzedAt: input.analyzedAt,
    modelSettings: { model: text(settings.model, 100), reasoningEffort: settings.reasoningEffort as ModelSettings['reasoningEffort'], ...(preset ? { preset } : {}) } }
}
