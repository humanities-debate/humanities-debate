// SPDX-License-Identifier: LicenseRef-SIWC-DevKit-Noncommercial-1.0
// Modified DevKit module, Humanities Debate contributors, 2026-11-15.
// Original: OpenAI Sign in with ChatGPT DevKit. See licenses/DEVKIT_LICENSE.txt.
// 8F adapter for the official DevKit. Auth remains in the pinned @siwc/local SDK.
// Added reasoning/strict JSON schema; no tools, file access, paid API keys or retries.
import OpenAI from 'openai'
import { ChatGPTError } from '@siwc-internal/errors'

export async function streamResponse(accessToken, options, signal) {
  const client = new OpenAI({ apiKey: accessToken, baseURL: 'https://api.openai.com/v1', organization: null, project: null,
    maxRetries: 0, logLevel: 'off', fetchOptions: { redirect: 'error' },
    defaultHeaders: { authorization: `Bearer ${accessToken}`, 'openai-organization': null, 'openai-project': null } })
  const input = typeof options.input === 'string' ? [{ role: 'user', content: options.input }] : options.input
  const combined = AbortSignal.any([signal, AbortSignal.timeout(120_000)])
  try {
    const body = { model: options.model, input, store: false, stream: true,
      ...(options.instructions ? { instructions: options.instructions } : {}),
      ...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort } } : {}),
      ...(options.outputSchema ? { text: { format: { type: 'json_schema', name: 'debate_response', strict: true, schema: options.outputSchema } } } : {}) }
    const { data, response } = await client.responses.create(body, { signal: combined }).withResponse()
    if (!response.body) throw Object.assign(new Error('INVALID_STREAM'), { code: 'invalid_stream' })
    let text = '', completed = false
    for await (const event of data) {
      combined.throwIfAborted()
      if (event.type === 'response.output_text.delta') {
        text += event.delta
        if (text.length > 100_000) throw Object.assign(new Error('RESPONSE_LIMIT'), { code: 'response_too_large' })
        options.onDelta?.(event.delta)
      } else if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) {
        const code = event.response?.error?.code || event.error?.code || event.code || 'stream_interrupted'
        throw Object.assign(new Error('RESPONSE_FAILED'), { code })
      } else if (event.type === 'response.completed') {
        if (event.response?.status !== 'completed' || event.response?.output?.some(item => item.type !== 'message' && item.type !== 'reasoning')) {
          throw Object.assign(new Error('UNEXPECTED_OUTPUT'), { code: 'unexpected_output' })
        }
        completed = true
        break
      }
    }
    combined.throwIfAborted()
    if (!completed || !text.trim()) throw Object.assign(new Error('STREAM_NOT_COMPLETED'), { code: 'stream_interrupted' })
    return { text }
  } catch (error) {
    // Never forward SDK error messages/bodies: they can contain prompts or credentials.
    const code = signal.aborted ? 'cancelled' : combined.aborted ? 'timeout' :
      error?.code || error?.error?.code || (error instanceof OpenAI.APIConnectionError ? 'network_error' : 'response_failed')
    throw new ChatGPTError(/^[a-zA-Z_]{1,100}$/.test(code) ? code : 'response_failed', 'SIWC_REQUEST_FAILED', false,
      Number.isInteger(error?.status) ? error.status : undefined)
  }
}
