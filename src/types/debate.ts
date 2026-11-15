import type { PresetSelection } from '../config/aiPresets.ts'
import type { DiscussionState } from '../logic/discussion.ts'
import type { AcceptedContribution } from '../logic/contribution.ts'

export type AIId = 'ai1' | 'ai2' | 'ai3'
export type SpeakerId = 'user' | AIId
export type TopicContext = { situation?: string; keyIssue?: string }
export type DebateTopic = {
  id: string
  title: string
  category: string
  source: 'prepared' | 'custom'
  context?: TopicContext
  mockPoints?: readonly [string, string, string]
}
export type ReasoningEffort = 'low' | 'medium' | 'high'
export type ModelSettings = { model: string; reasoningEffort: ReasoningEffort; preset?: PresetSelection }
export type ModelChoice = { model: string; displayName: string; reasoningEfforts: ReasoningEffort[] }
export type ModelCatalog = { models: ModelChoice[]; defaultSettings: ModelSettings }
export type DebateSession = { id: number; topic: DebateTopic; startedAt: number; endedAt: number | null; modelSettings?: ModelSettings | null }
export type Participant = { id: SpeakerId; name: string; initials: string; role: string; description: string }
export type AIPersona = {
  id: AIId
  personality: string
  speechStyle: string
  rules: readonly string[]
  exampleExpressions: readonly string[]
}

// Original messages are independent from visibility and can be reused for analysis.
export type Message = {
  id: string
  speakerId: SpeakerId
  text: string
  turnId: number
  timestamp: number
  elapsedMs?: number
  speakerName?: string
  isUser: boolean
  source: 'mock' | 'real' | 'text' | 'speech'
  sessionId: number
  replyToId?: string
}
export type AIRequest = {
  discussion?: DiscussionState
  contributions?: AcceptedContribution[]
  modelSettings?: ModelSettings
  speakerId: AIId
  topic: string
  topicDetails: DebateTopic
  history: readonly Message[]
  persona: AIPersona
  conversationRules: readonly string[]
}
