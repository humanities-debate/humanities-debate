import { aiIds, participants } from '../data/mockDebate.ts'
import { practiceTopics } from '../data/topics.ts'
import { customTopic } from './topics.ts'
import { personas, conversationRules } from '../data/personas.ts'
import { presetMatches } from '../config/aiPresets.ts'
import { parseDiscussion, discussionFocus } from './discussion.ts'
import type { DiscussionState } from './discussion.ts'
import { parseContribution } from './contribution.ts'
import type { AcceptedContribution, Contribution } from './contribution.ts'
import { metadataDiagnostic, logMetadataDiagnostic } from './debateMetadata.ts'
import { userReplyTarget } from './userReplyTarget.ts'
import type { AIId, AIRequest, DebateTopic, DebateSession, Message, SpeakerId, ModelSettings } from '../types/debate.ts'

export const WAIT_SECONDS_OPTIONS = [5, 10, 20, 30, 40, 50] as const
export type WaitSeconds = (typeof WAIT_SECONDS_OPTIONS)[number]
export const AI_TYPING_MS = 5000
export const MAX_INPUT_LENGTH = 4000
export type ActiveStatus = 'aiTyping' | 'aiShowing' | 'userSpeaking'
export type DebateState = {
  status: 'idle' | ActiveStatus | 'paused' | 'finished'
  mode: 'normal' | 'practice'
  engine: 'real' | 'mock'
  modelSettings: ModelSettings | null
  discussion: DiscussionState | null
  contributions: AcceptedContribution[]
  waitSeconds: WaitSeconds
  history: Message[]
  topic: DebateTopic | null
  sessions: DebateSession[]
  sessionId: number
  activeSpeaker: SpeakerId | null
  visibleMessageId: string | null
  pending: AIRequest | null
  generationId: number
  waitUntil: number | null
  draft: string
  draftSource: 'text' | 'speech'
  error: string | null
  startedAt: number | null
  endedAt: number | null
  pausedAt: number | null
  pausedMs: number
  resumeStatus: ActiveStatus | null
}
export const initialState: DebateState = {
  status: 'idle', mode: 'normal', waitSeconds: 10, history: [], sessionId: 0, activeSpeaker: null,
  visibleMessageId: null, pending: null, generationId: 0, waitUntil: null, draft: '', draftSource: 'text',
  error: null, startedAt: null, endedAt: null, pausedAt: null, pausedMs: 0, resumeStatus: null,
  topic: null, sessions: [], engine: 'mock', modelSettings: null, discussion: null, contributions: [],
}
export type DebateAction =
  | { type: 'START'; topic: DebateTopic; timestamp: number }
  | { type: 'END' | 'USER_START' | 'PAUSE' | 'RESUME'; timestamp: number }
  | { type: 'NEXT' | 'WAIT_ELAPSED' | 'USER_FINISH' | 'USER_CANCEL'; generationId: number; timestamp: number }
  | { type: 'DRAFT'; text: string }
  | { type: 'VOICE_DRAFT'; text: string; generationId: number }
  | { type: 'VOICE_FINISH'; text: string; generationId: number; timestamp: number }
  | { type: 'MODE'; mode: DebateState['mode'] }
  | { type: 'ENGINE'; engine: DebateState['engine'] }
  | { type: 'MODEL_SETTINGS' | 'MODEL_DEFAULT'; settings: ModelSettings }
  | { type: 'WAIT_SETTING'; seconds: number; timestamp: number }
  | { type: 'AI_READY'; text: string; discussion?: DiscussionState; contribution?: Contribution; generationId: number; timestamp: number }
  | { type: 'AI_ERROR'; generationId: number; timestamp: number; message?: string }

export function isActive(status: DebateState['status']): status is ActiveStatus {
  return status === 'aiTyping' || status === 'aiShowing' || status === 'userSpeaking'
}
export function sessionMessages(state: DebateState) {
  return state.history.filter((message) => message.sessionId === state.sessionId)
}

// Clear user questions may return the floor to their addressee once. Otherwise
// retain the balanced policy, including all AI-only turns and ambiguous requests.
export function selectNextSpeaker(history: readonly Message[], discussion: DiscussionState | null = null, contributions: readonly AcceptedContribution[] = []): AIId {
  const aiMessages = history.filter((message) => !message.isUser)
  const preferred = userReplyTarget(history, discussion, contributions)
  if (preferred && !(aiMessages.length >= 2 && aiMessages.slice(-2).every(m => m.speakerId === preferred.speakerId))) return preferred.speakerId
  const lastAI = aiMessages.at(-1)?.speakerId
  const counts = Object.fromEntries(aiIds.map((id) => [id, aiMessages.filter((message) => message.speakerId === id).length])) as Record<AIId, number>
  const offset = Math.floor(aiMessages.length / aiIds.length) % aiIds.length
  const order = [...aiIds.slice(offset), ...aiIds.slice(0, offset)].filter((id) => id !== lastAI)
  return order.reduce((best, id) => counts[id] < counts[best] ? id : best)
}
function beginAI(state: DebateState): DebateState {
  if (!state.topic) return state
  const history = sessionMessages(state)
  const speakerId = selectNextSpeaker(history, state.discussion, state.contributions)
  return { ...state, status: 'aiTyping', activeSpeaker: speakerId, visibleMessageId: null,
    pending: { speakerId, topic: state.topic.title, topicDetails: state.topic, history, persona: personas[speakerId], conversationRules,
      contributions: state.contributions, ...(state.discussion ? { discussion: state.discussion } : {}),
      ...(state.modelSettings ? { modelSettings: { ...state.modelSettings } } : {}) }, waitUntil: null, generationId: state.generationId + 1, error: null }
}
function appendMessage(state: DebateState, speakerId: SpeakerId, text: string, timestamp: number): DebateState {
  const turnId = state.history.length + 1
  const message: Message = { id: 'msg-' + turnId, speakerId, text, timestamp, turnId,
    speakerName: participants.find(participant => participant.id === speakerId)!.name,
    elapsedMs: Math.max(0, timestamp - (state.startedAt ?? timestamp) - state.pausedMs),
    isUser: speakerId === 'user', source: speakerId === 'user' ? state.draftSource : state.engine, sessionId: state.sessionId,
    replyToId: sessionMessages(state).at(-1)?.id }
  return { ...state, status: 'aiShowing', activeSpeaker: speakerId, visibleMessageId: message.id,
    pending: null, history: [...state.history, message], draft: '', waitUntil: timestamp + state.waitSeconds * 1000,
    generationId: state.generationId + 1 }
}

export function debateReducer(state: DebateState, action: DebateAction): DebateState {
  switch (action.type) {
    case 'START': {
      if (state.status !== 'idle' && state.status !== 'finished') return state
      if (state.engine === 'real' && !state.modelSettings) return state
      const topic = action.topic.source === 'custom' ? customTopic(action.topic.title) : practiceTopics.find(item => item.id === action.topic.id)
      if (!topic) return state
      const sessionId = state.sessionId + 1
      return beginAI({ ...initialState, mode: state.mode, engine: state.engine, modelSettings: state.modelSettings ? { ...state.modelSettings } : null, waitSeconds: state.waitSeconds, history: state.history,
        topic, sessions: [...state.sessions, { id: sessionId, topic, startedAt: action.timestamp, endedAt: null, modelSettings: state.modelSettings ? { ...state.modelSettings } : null }],
        sessionId, generationId: state.generationId, startedAt: action.timestamp })
    }
    case 'END':
      if (!isActive(state.status) && state.status !== 'paused') return state
      return { ...state, status: 'finished', endedAt: action.timestamp, pending: null, waitUntil: null,
        sessions: state.sessions.map(session => session.id === state.sessionId ? { ...session, endedAt: action.timestamp } : session),
        pausedMs: state.pausedMs + (state.pausedAt === null ? 0 : action.timestamp - state.pausedAt),
        pausedAt: null, resumeStatus: null, draft: '', error: null, generationId: state.generationId + 1 }
    case 'MODE':
      return { ...state, mode: action.mode }
    case 'ENGINE':
      if (isActive(state.status) || state.engine === action.engine) return state
      if (action.engine === 'real' && state.status === 'paused' && !state.modelSettings) return { ...state, error: '이 세션에는 AI 모델 설정이 없습니다. 토론 종료 후 모델을 선택해 새로 시작해 주세요.' }
      return { ...state, engine: action.engine, error: null, generationId: state.generationId + 1 }
    case 'MODEL_DEFAULT':
    case 'MODEL_SETTINGS':
      if ((state.status !== 'idle' && state.status !== 'finished') || (action.type === 'MODEL_DEFAULT' && state.modelSettings)) return state
      if (!action.settings.model.trim() || !['low', 'medium', 'high'].includes(action.settings.reasoningEffort)) return state
      if (!presetMatches(action.settings, 'debate')) return state
      return { ...state, modelSettings: { ...action.settings }, error: null }
    case 'WAIT_SETTING': {
      const seconds = WAIT_SECONDS_OPTIONS.find((value) => value === action.seconds)
      if (seconds === undefined || seconds === state.waitSeconds) return state
      // Restart only an active reading window. Keep AI preparation and user input intact.
      return { ...state, waitSeconds: seconds,
        waitUntil: state.status === 'aiShowing' ? action.timestamp + seconds * 1000 : state.waitUntil,
        generationId: state.generationId + (state.status === 'aiShowing' ? 1 : 0) }
    }
    case 'DRAFT':
      return state.status === 'userSpeaking' ? { ...state, draft: action.text.slice(0, MAX_INPUT_LENGTH) } : state
    case 'VOICE_DRAFT':
      if (state.status !== 'userSpeaking' || state.generationId !== action.generationId) return state
      return { ...state, draft: action.text.slice(0, MAX_INPUT_LENGTH), draftSource: action.text.trim() ? 'speech' : state.draftSource }
    case 'VOICE_FINISH':
      if (state.status !== 'userSpeaking' || state.generationId !== action.generationId) return state
      if (!action.text.trim()) return debateReducer(state, { type: 'USER_CANCEL', generationId: action.generationId, timestamp: action.timestamp })
      return beginAI(appendMessage({ ...state, draftSource: 'speech' }, 'user', action.text.trim().slice(0, MAX_INPUT_LENGTH), action.timestamp))
    case 'NEXT':
    case 'WAIT_ELAPSED':
      if (state.status !== 'aiShowing' || state.generationId !== action.generationId) return state
      if (action.type === 'WAIT_ELAPSED' && (state.waitUntil === null || action.timestamp < state.waitUntil)) return state
      return beginAI(state)
    case 'AI_READY': {
      if (state.status !== 'aiTyping' || !state.pending || state.generationId !== action.generationId || !action.text.trim()) return state
      let discussion = state.discussion
      if (action.discussion) {
        try { discussion = parseDiscussion(action.discussion, state.pending.topic, state.pending.history, true) }
        catch (error) { logMetadataDiagnostic(metadataDiagnostic(error)) }
      }
      let contribution: Contribution | undefined
      if (action.contribution) {
        try { contribution = parseContribution(action.contribution, state.pending.history, discussionFocus(state.discussion, state.pending.speakerId, state.pending.history, state.contributions)) }
        catch (error) { logMetadataDiagnostic(metadataDiagnostic(error)) }
      }
      const accepted = appendMessage({ ...state, discussion }, state.pending.speakerId, action.text.trim(), action.timestamp)
      // Commit only here, after generation/status checks and the visible message append.
      return contribution ? { ...accepted, contributions: [...state.contributions, { ...contribution,
        messageId: accepted.history.at(-1)!.id, speakerId: state.pending.speakerId }] } : accepted
    }
    case 'USER_START':
      if (!isActive(state.status) || state.status === 'userSpeaking') return state
      return { ...state, status: 'userSpeaking', pending: null, waitUntil: null, activeSpeaker: 'user',
        visibleMessageId: null, draft: '', draftSource: 'text', generationId: state.generationId + 1 }
    case 'USER_FINISH':
      if (state.status !== 'userSpeaking' || state.generationId !== action.generationId || !state.draft.trim()) return state
      return beginAI(appendMessage(state, 'user', state.draft.trim(), action.timestamp))
    case 'USER_CANCEL':
      if (state.status !== 'userSpeaking' || state.generationId !== action.generationId) return state
      return { ...state, status: 'aiShowing', activeSpeaker: null, draft: '', waitUntil: action.timestamp + state.waitSeconds * 1000,
        generationId: state.generationId + 1 }
    case 'PAUSE':
      if (!isActive(state.status)) return state
      return { ...state, status: 'paused', resumeStatus: state.status, pausedAt: action.timestamp,
        pending: null, waitUntil: null, generationId: state.generationId + 1 }
    case 'RESUME': {
      if (state.status !== 'paused' || !state.resumeStatus || state.pausedAt === null) return state
      const resumed: DebateState = { ...state, status: state.resumeStatus, resumeStatus: null, pausedAt: null,
        pausedMs: state.pausedMs + action.timestamp - state.pausedAt, error: null, generationId: state.generationId + 1 }
      if (resumed.status === 'aiTyping') return beginAI(resumed)
      return { ...resumed, waitUntil: resumed.status === 'aiShowing' ? action.timestamp + resumed.waitSeconds * 1000 : null }
    }
    case 'AI_ERROR':
      if (state.status !== 'aiTyping' || state.generationId !== action.generationId) return state
      return { ...state, status: 'paused', resumeStatus: 'aiTyping', pausedAt: action.timestamp,
        pending: null, waitUntil: null, generationId: state.generationId + 1,
        error: (action.message ?? 'AI 응답을 준비하지 못했습니다.') + ' 기록은 보존됩니다. 재개로 재시도하거나 AI 모드를 변경해 주세요.' }
  }
}

export function participantView(state: DebateState, speakerId: SpeakerId) {
  const message = state.history.findLast((item) => item.sessionId === state.sessionId && item.speakerId === speakerId)
  return {
    message,
    active: isActive(state.status) && state.activeSpeaker === speakerId,
    preparing: state.status === 'aiTyping' && state.pending?.speakerId === speakerId,
    speaking: state.status === 'userSpeaking' && speakerId === 'user',
    hidden: Boolean(message && state.mode === 'practice' && message.id !== state.visibleMessageId),
  }
}
export function elapsedSeconds(state: DebateState, now: number) {
  return state.startedAt === null ? 0 : Math.max(0, Math.floor(((state.endedAt ?? state.pausedAt ?? now) - state.startedAt - state.pausedMs) / 1000))
}
