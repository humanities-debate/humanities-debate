import type { AIId, SpeakerId } from '../types/debate.ts'
import { MetadataValidationError } from './debateMetadata.ts'

type Source = { id: string; speakerId: string; turnId: number }
export const contributionPurposes = ['answer-user', 'answer-objection', 'counter-rebuttal', 'establish-position',
  'test-disagreement-in-related-case', 'develop-related-issue', 'test-unresolved-premise', 'deepen-current-issue'] as const
export type ContributionPurpose = (typeof contributionPurposes)[number]
export type Contribution = {
  targetIds: string[]
  purpose: ContributionPurpose
  argumentKey: string
  point: string
  // A concrete condition/example/difference, not a claim that the text is novel.
  advance: string | null
  answeredObjectionIds: string[]
  // The app supplies the accepted message ID as the follow-up target, never the model.
  followUpFor: SpeakerId | 'any' | null
}
export type AcceptedContribution = Contribution & { messageId: string; speakerId: AIId }
export type TurnFocus = { purpose: ContributionPurpose; targetId?: string | null; question?: string; unresolvedDifference?: string }
const nullableText = { type: ['string', 'null'], maxLength: 180 }
export const contributionSchema = {
  type: 'object', additionalProperties: false,
  required: ['targetIds', 'purpose', 'argumentKey', 'point', 'advance', 'answeredObjectionIds', 'followUpFor'],
  properties: {
    targetIds: { type: 'array', maxItems: 3, items: { type: 'string' } },
    purpose: { type: 'string', enum: contributionPurposes }, argumentKey: { type: 'string', maxLength: 60 },
    point: { type: 'string', maxLength: 300 }, advance: nullableText,
    answeredObjectionIds: { type: 'array', maxItems: 3, items: { type: 'string' } },
    followUpFor: { type: ['string', 'null'], enum: ['user', 'ai1', 'ai2', 'ai3', 'any', null] },
  },
}

export function parseContribution(value: unknown, history: readonly Source[], focus?: TurnFocus): Contribution {
  const fail = (reason: string, field: string): never => { throw new MetadataValidationError('CONTRIBUTION', reason, 'contribution.' + field) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('SHAPE', 'root')
  const v = value as Record<string, unknown>
  const keys = contributionSchema.required
  if (Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) return fail('SHAPE', 'root')
  const sources = new Set(history.map(m => m.id))
  const refs = (value: unknown, field: string) => {
    if (!Array.isArray(value) || value.length > 3) return fail('COUNT', field)
    if (value.some(id => typeof id !== 'string' || !sources.has(id))) return fail('UNKNOWN_REFERENCE', field)
    if (new Set(value).size !== value.length) return fail('DUPLICATE_REFERENCE', field)
    return value as string[]
  }
  const str = (value: unknown, field: string, max: number) => typeof value === 'string' && value.trim() && value.length <= max ? value : fail('TEXT_BOUND', field)
  if (!contributionPurposes.includes(v.purpose as ContributionPurpose)) return fail('PURPOSE', 'purpose')
  const targetIds = refs(v.targetIds, 'targetIds'), answeredObjectionIds = refs(v.answeredObjectionIds, 'answeredObjectionIds')
  if (answeredObjectionIds.some(id => !targetIds.includes(id))) return fail('ANSWER_NOT_TARGETED', 'answeredObjectionIds')
  if (v.followUpFor !== null && !['user', 'ai1', 'ai2', 'ai3', 'any'].includes(String(v.followUpFor))) return fail('SPEAKER', 'followUpFor')
  if (focus && (v.purpose !== focus.purpose || (focus.targetId && !targetIds.includes(focus.targetId)))) return fail('PLAN_MISMATCH', 'purpose')
  if (focus?.targetId && ['answer-user', 'answer-objection', 'counter-rebuttal'].includes(focus.purpose) && !answeredObjectionIds.includes(focus.targetId)) return fail('ANSWER_MISSING', 'answeredObjectionIds')
  return { targetIds, purpose: v.purpose as ContributionPurpose, argumentKey: str(v.argumentKey, 'argumentKey', 60), point: str(v.point, 'point', 300),
    advance: v.advance === null ? null : str(v.advance, 'advance', 180), answeredObjectionIds, followUpFor: v.followUpFor as Contribution['followUpFor'] }
}

// The ledger is session memory, separate from immutable transcripts/feedback storage.
export function parseContributions(value: unknown, history: readonly Source[]): AcceptedContribution[] {
  const fail = (reason: string, field: string): never => { throw new MetadataValidationError('CONTRIBUTION', reason, field) }
  if (!Array.isArray(value) || value.length > 500) return fail('COUNT', 'contributions')
  let previousTurn = 0
  return value.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('SHAPE', 'contributions.entry')
    const { messageId, speakerId, ...item } = raw
    const message = history.find(m => m.id === messageId)
    if (!message || message.speakerId === 'user' || message.speakerId !== speakerId) return fail('UNKNOWN_OR_WRONG_SPEAKER', 'contributions.messageId')
    if (message.turnId <= previousTurn) return fail('TIME_ORDER', 'contributions.messageId')
    previousTurn = message.turnId
    return { ...parseContribution(item, history.filter(m => m.turnId < message.turnId)), messageId, speakerId }
  })
}

export function validateContributionUse(item: Contribution, speakerId: string, ledger: readonly AcceptedContribution[], sameSideIds: readonly string[]) {
  const used = ledger.filter(c => (c.speakerId === speakerId || sameSideIds.includes(c.speakerId)) && c.argumentKey === item.argumentKey)
  if (!used.length || item.advance) return
  // A direct reply to a *new* objection may legitimately reuse the same reason.
  const direct = ['answer-user', 'answer-objection', 'counter-rebuttal'].includes(item.purpose)
  if (direct && item.answeredObjectionIds.some(id => !used.some(c => c.answeredObjectionIds.includes(id)))) return
  throw new MetadataValidationError('CONTRIBUTION', 'REUSED_REASON_WITHOUT_ADVANCE', 'contribution.argumentKey')
}
