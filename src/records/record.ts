import { participants } from '../data/mockDebate.ts'
import { sessionMessages } from '../logic/debate.ts'
import type { DebateState } from '../logic/debate.ts'
import type { DebateTopic, Message, ModelSettings, SpeakerId } from '../types/debate.ts'
import { parseFeedback } from './feedback.ts'
import type { Feedback } from './feedback.ts'
import { parsePreset } from '../config/aiPresets.ts'

export type RecordMessage = Pick<Message, 'id' | 'turnId' | 'speakerId' | 'isUser' | 'text' | 'timestamp' | 'source' | 'replyToId'> & {
  order: number; speakerName: string; elapsedMs: number
}
export type DebateRecord = {
  schemaVersion: 1
  id: string
  topic: DebateTopic
  startedAt: number
  endedAt: number
  durationMs: number
  mode: 'normal' | 'practice'
  modelSettings: ModelSettings | null
  messages: RecordMessage[]
  feedback?: Feedback
}

// Build only from the reducer's committed history, never from pending replies or speech drafts.
export function completedRecord(state: DebateState, id: string): DebateRecord | null {
  if (state.status !== 'finished' || !state.topic || state.startedAt === null || state.endedAt === null) return null
  return parseRecord({
    schemaVersion: 1, id, topic: state.topic, startedAt: state.startedAt, endedAt: state.endedAt,
    durationMs: Math.max(0, state.endedAt - state.startedAt - state.pausedMs), mode: state.mode,
    modelSettings: state.modelSettings,
    messages: sessionMessages(state).map((message, index) => ({ ...message, order: index + 1,
      speakerName: message.speakerName ?? participants.find(person => person.id === message.speakerId)!.name,
      elapsedMs: message.elapsedMs ?? Math.max(0, message.timestamp - state.startedAt!),
    })),
  })
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('기록 형식이 올바르지 않습니다.')
  return value as Record<string, unknown>
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('기록의 글 내용을 확인할 수 없습니다.')
  return value // Preserve the original text, including newlines.
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) throw new Error('기록의 시간이 올바르지 않습니다.')
  return value
}
function choice<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error('지원하지 않는 기록 값입니다.')
  return value as T
}

// Also projects an explicit allowlist: no auth, SDK session, draft, or arbitrary state is serialized.
export function parseRecord(value: unknown): DebateRecord {
  const raw = object(value)
  if (raw.schemaVersion !== 1) throw new Error('지원하지 않는 기록 버전입니다. 원본은 그대로 보관됩니다.')
  const id = text(raw.id, 100)
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('기록 ID가 올바르지 않습니다.')
  const inputTopic = object(raw.topic)
  const topic: DebateTopic = { id: text(inputTopic.id, 400), title: text(inputTopic.title, 300),
    category: text(inputTopic.category, 100), source: choice(inputTopic.source, ['prepared', 'custom']) }
  if (inputTopic.context !== undefined) {
    const context = object(inputTopic.context)
    topic.context = {
      ...(context.situation === undefined ? {} : { situation: text(context.situation, 1200) }),
      ...(context.keyIssue === undefined ? {} : { keyIssue: text(context.keyIssue, 600) }),
    }
  }
  let modelSettings: ModelSettings | null = null
  if (raw.modelSettings !== null) {
    const settings = object(raw.modelSettings)
    modelSettings = { model: text(settings.model, 100), reasoningEffort: choice(settings.reasoningEffort, ['low', 'medium', 'high']) }
    const preset = parsePreset(settings.preset, 'debate')
    if (preset) modelSettings.preset = preset
  }
  if (!Array.isArray(raw.messages)) throw new Error('발언 목록을 확인할 수 없습니다.')
  const seen = new Set<string>()
  let previousTurn = 0
  const messages = raw.messages.map((item, index): RecordMessage => {
    const message = object(item)
    const messageId = text(message.id, 100)
    const speakerId = choice(message.speakerId, ['user', 'ai1', 'ai2', 'ai3'])
    const turnId = number(message.turnId)
    if (seen.has(messageId) || turnId <= previousTurn || message.order !== index + 1 || message.isUser !== (speakerId === 'user')) throw new Error('발언 순서나 참가자 정보가 올바르지 않습니다.')
    const replyToId = message.replyToId === undefined ? undefined : text(message.replyToId, 100)
    if (replyToId && !seen.has(replyToId)) throw new Error('연결된 이전 발언이 없습니다.')
    seen.add(messageId)
    previousTurn = turnId
    return { id: messageId, order: index + 1, turnId, speakerId, speakerName: text(message.speakerName, 100),
      isUser: speakerId === 'user', text: text(message.text, 4000), timestamp: number(message.timestamp),
      elapsedMs: number(message.elapsedMs), source: choice(message.source, ['mock', 'real', 'text', 'speech']),
      ...(replyToId ? { replyToId } : {}),
    }
  })
  const record: DebateRecord = { schemaVersion: 1, id, topic, startedAt: number(raw.startedAt), endedAt: number(raw.endedAt),
    durationMs: number(raw.durationMs), mode: choice(raw.mode, ['normal', 'practice']), modelSettings, messages }
  if (raw.feedback !== undefined) record.feedback = parseFeedback(raw.feedback, record)
  return record
}

// 6B can refer to evidence by (record.id, message.id), without generating any analysis here.
export const participantMessages = (record: DebateRecord, id: SpeakerId) => record.messages.filter(message => message.speakerId === id)
export const userMessages = (record: DebateRecord) => participantMessages(record, 'user')
export const evidenceMessage = (record: DebateRecord, id: string) => record.messages.find(message => message.id === id)
export function recordText(record: DebateRecord) {
  return [record.topic.title, record.topic.context?.situation, record.topic.context?.keyIssue,
    ...record.messages.map(message => `${message.order}. ${message.speakerName} [${formatDuration(message.elapsedMs)}]\n${message.text}`),
  ].filter(Boolean).join('\n\n')
}
export function formatDuration(ms: number) {
  const seconds = Math.floor(ms / 1000)
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}
