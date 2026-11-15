import type { AIRequest } from '../types/debate.ts'
import type { DiscussionState } from '../logic/discussion.ts'
import type { Contribution } from '../logic/contribution.ts'

// Only explicitly safe user-facing errors are displayed by the scheduler.
export class AIProviderError extends Error {}

export interface AIProvider {
  generateReply(request: AIRequest, signal: AbortSignal): Promise<{ text: string; discussion?: DiscussionState; contribution?: Contribution }>
}
