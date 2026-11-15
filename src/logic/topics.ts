import { practiceTopics } from '../data/topics.ts'
import type { DebateTopic } from '../types/debate.ts'

export const MAX_TOPIC_LENGTH = 300
export const RECENT_TOPIC_COUNT = 5
export type TopicSelection = { mode: 'random' | 'list' | 'custom'; selectedId: string; customText: string; previewId: string | null }
export const initialTopicSelection: TopicSelection = { mode: 'random', selectedId: practiceTopics[0].id, customText: '', previewId: null }

export function customTopic(text: string): DebateTopic | null {
  const title = text.trim()
  if (!title || title.length > MAX_TOPIC_LENGTH) return null
  return { id: 'custom:' + title, title, category: '직접 입력', source: 'custom' }
}

export function selectionPreview(selection: TopicSelection): DebateTopic | null {
  if (selection.mode === 'custom') return customTopic(selection.customText)
  const id = selection.mode === 'list' ? selection.selectedId : selection.previewId
  return practiceTopics.find(topic => topic.id === id) ?? null
}

// Randomness is injected outside the reducer; exclude recent sessions and the current preview.
export function drawTopic(recentIds: readonly string[], previewId: string | null = null, random = Math.random): DebateTopic {
  const excluded = new Set([...recentIds.slice(-RECENT_TOPIC_COUNT), previewId])
  const candidates = practiceTopics.filter(topic => !excluded.has(topic.id))
  return candidates[Math.floor(random() * candidates.length)]
}

export function topicForStart(selection: TopicSelection, recentIds: readonly string[], random = Math.random): DebateTopic | null {
  return selectionPreview(selection) ?? (selection.mode === 'random' ? drawTopic(recentIds, null, random) : null)
}
