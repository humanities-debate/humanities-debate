import type { SpeakerId } from '../types/debate.ts'
import type { AcceptedContribution, TurnFocus } from './contribution.ts'
import { MetadataValidationError } from './debateMetadata.ts'

type Source = { id: string; speakerId: string; turnId: number }
export type DiscussionState = {
  version: 1
  topic: string
  throughId: string | null
  currentIssue: { key: string; question: string; status: 'open' | 'examined' | 'settled'; sourceIds: string[] }
  positions: { speakerId: SpeakerId; claim: string; reason: string; sourceIds: string[] }[]
  coveredArguments: { key: string; point: string; sourceIds: string[] }[]
  openObjections: { sourceId: string; againstId: string | null; forSpeaker: SpeakerId | 'any'; point: string }[]
  nextIssues: string[]
}
const text = (max: number) => ({ type: 'string', maxLength: max })
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties })
const list = (items: unknown, maxItems: number) => ({ type: 'array', maxItems, items })
const ids = list(text(100), 4)
export const discussionSchema = object({
  version: { type: 'integer', enum: [1] }, topic: text(300), throughId: { type: ['string', 'null'] },
  currentIssue: object({ key: text(60), question: text(160), status: { type: 'string', enum: ['open', 'examined', 'settled'] }, sourceIds: list(text(100), 8) }),
  positions: list(object({ speakerId: { type: 'string', enum: ['user','ai1','ai2','ai3'] }, claim: text(180), reason: text(180), sourceIds: ids }), 4),
  coveredArguments: list(object({ key: text(60), point: text(180), sourceIds: ids }), 8),
  openObjections: list(object({ sourceId: text(100), againstId: { type: ['string', 'null'] }, forSpeaker: { type: 'string', enum: ['user','ai1','ai2','ai3','any'] }, point: text(180) }), 4),
  nextIssues: list(text(160), 3),
})

// Validate provenance and bounds; semantic summaries remain fallible model output.
export function parseDiscussion(value: unknown, topic: string, history: readonly Source[], complete = false): DiscussionState {
  const fail = (reason: string, field: string): never => { throw new MetadataValidationError('DISCUSSION', reason, 'discussion.' + field) }
  const obj = (v: unknown, keys: string[], field: string): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) return fail('SHAPE', field)
    return v as Record<string, unknown>
  }
  const str = (v: unknown, max: number, field: string): string => typeof v === 'string' && v.trim() && v.length <= max ? v : fail('TEXT_BOUND', field)
  const arr = (v: unknown, max: number, field: string): unknown[] => Array.isArray(v) && v.length <= max ? v : fail('COUNT', field)
  const unique = (values: string[], field: string) => new Set(values).size === values.length ? values : fail('DUPLICATE', field)
  const encoded = JSON.stringify(value)
  if (!encoded || encoded.length > 16_000) return fail('SIZE', 'root')
  const v = obj(value, ['version','topic','throughId','currentIssue','positions','coveredArguments','openObjections','nextIssues'], 'root')
  if (v.version !== 1) return fail('VERSION', 'version')
  if (v.topic !== topic) return fail('TOPIC_MISMATCH', 'topic')
  const through = v.throughId === null ? null : history.find(m => m.id === v.throughId) ?? fail('UNKNOWN_REFERENCE', 'throughId')
  if (complete && v.throughId !== (history.at(-1)?.id ?? null)) return fail('STALE_SNAPSHOT', 'throughId')
  const sources = new Map(history.filter(m => through && m.turnId <= through.turnId).map(m => [m.id, m]))
  const ref = (id: unknown, field: string): string => typeof id === 'string' && sources.has(id) ? id : fail('UNKNOWN_REFERENCE', field)
  const refs = (v: unknown, field: string, required = true, max = 4) => {
    const result = unique(arr(v, max, field).map(id => ref(id, field)), field)
    if (required && !result.length) return fail('MISSING_EVIDENCE', field)
    return result
  }
  const issue = obj(v.currentIssue, ['key','question','status','sourceIds'], 'currentIssue')
  if (issue.status !== 'open' && issue.status !== 'examined' && issue.status !== 'settled') return fail('STATUS', 'currentIssue.status')
  const issueSources = refs(issue.sourceIds, 'currentIssue.sourceIds', false, 8)
  // Provenance across participants is required; a four-AI quota cannot prove depth.
  // Include user evidence too. Semantic examination/agreement is still fallible.
  if (issue.status !== 'open' && new Set(issueSources.map(id => sources.get(id)!.speakerId)).size < 2) return fail('PARTICIPANT_EVIDENCE', 'currentIssue.sourceIds')
  const positions = arr(v.positions, 4, 'positions').map(raw => {
    const p = obj(raw, ['speakerId','claim','reason','sourceIds'], 'positions.entry')
    if (!['user','ai1','ai2','ai3'].includes(String(p.speakerId))) return fail('SPEAKER', 'positions.speakerId')
    const sourceIds = refs(p.sourceIds, 'positions.sourceIds')
    if (sourceIds.some(id => sources.get(id)!.speakerId !== p.speakerId)) return fail('WRONG_SPEAKER', 'positions.sourceIds')
    return { speakerId: p.speakerId as SpeakerId, claim: str(p.claim, 180, 'positions.claim'), reason: str(p.reason, 180, 'positions.reason'), sourceIds }
  })
  unique(positions.map(p => p.speakerId), 'positions.speakerId')
  const coveredArguments = arr(v.coveredArguments, 8, 'coveredArguments').map(raw => {
    const a = obj(raw, ['key','point','sourceIds'], 'coveredArguments.entry')
    return { key: str(a.key, 60, 'coveredArguments.key'), point: str(a.point, 180, 'coveredArguments.point'), sourceIds: refs(a.sourceIds, 'coveredArguments.sourceIds') }
  })
  unique(coveredArguments.map(a => a.key), 'coveredArguments.key')
  const openObjections = arr(v.openObjections, 4, 'openObjections').map(raw => {
    const a = obj(raw, ['sourceId','againstId','forSpeaker','point'], 'openObjections.entry')
    const sourceId = ref(a.sourceId, 'openObjections.sourceId'), againstId = a.againstId === null ? null : ref(a.againstId, 'openObjections.againstId')
    if (againstId && sources.get(againstId)!.turnId >= sources.get(sourceId)!.turnId) return fail('TIME_ORDER', 'openObjections.againstId')
    if (!['user','ai1','ai2','ai3','any'].includes(String(a.forSpeaker))) return fail('SPEAKER', 'openObjections.forSpeaker')
    return { sourceId, againstId, forSpeaker: a.forSpeaker as SpeakerId | 'any', point: str(a.point, 180, 'openObjections.point') }
  })
  unique(openObjections.map(a => a.sourceId), 'openObjections.sourceId')
  return { version: 1, topic, throughId: through?.id ?? null,
    currentIssue: { key: str(issue.key, 60, 'currentIssue.key'), question: str(issue.question, 160, 'currentIssue.question'), status: issue.status, sourceIds: issueSources },
    positions, coveredArguments, openObjections, nextIssues: unique(arr(v.nextIssues, 3, 'nextIssues').map(x => str(x, 160, 'nextIssues')), 'nextIssues') }
}

export function discussionFocus(state: DiscussionState | null, speakerId: string, history: readonly Source[], contributions: readonly AcceptedContribution[] = []): TurnFocus {
  const latest = history.at(-1)
  if (latest?.speakerId === 'user') return { purpose: 'answer-user', targetId: latest.id }
  // A recorded answer is not agreement or proof of a successful refutation.
  const answered = new Set(contributions.flatMap(c => c.answeredObjectionIds))
  const objections = (state?.openObjections ?? []).filter(o => !answered.has(o.sourceId) && o.forSpeaker !== 'user' && history.find(m => m.id === o.sourceId)?.speakerId !== speakerId)
    .sort((a, b) => Number(b.forSpeaker === speakerId) - Number(a.forSpeaker === speakerId))
  if (objections.length) return { purpose: 'answer-objection', targetId: objections[0].sourceId }
  const followUp = contributions.find(c => c.speakerId !== speakerId && (c.followUpFor === speakerId || c.followUpFor === 'any') && !answered.has(c.messageId))
  if (followUp) return { purpose: 'counter-rebuttal', targetId: followUp.messageId }
  if (!state) return { purpose: 'establish-position', targetId: latest?.id ?? null }
  if (state.currentIssue.status === 'examined' && state.nextIssues.length) return { purpose: 'test-disagreement-in-related-case', question: state.nextIssues[0], unresolvedDifference: state.currentIssue.question }
  if (state.currentIssue.status === 'settled' && state.nextIssues.length) return { purpose: 'develop-related-issue', question: state.nextIssues[0] }
  if (state.coveredArguments.some(a => a.sourceIds.length >= 2)) return { purpose: 'test-unresolved-premise', question: state.currentIssue.question }
  return { purpose: 'deepen-current-issue', question: state.currentIssue.question }
}
