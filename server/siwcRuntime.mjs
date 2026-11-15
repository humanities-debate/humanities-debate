import { DebateError, buildResponsesInput, replySchema, validateReply } from './dialogue.mjs'
import { buildFeedbackResponsesInput, feedbackSchema, validateFeedbackReply } from './feedback.mjs'
import { validateModelSettings } from './modelCatalog.mjs'
import { createStanceApproval, StanceError } from './stanceApproval.mjs'

export function siwcModelChoices(rows) {
  const efforts = ['low', 'medium', 'high']
  return rows.map(row => {
    const supported = row.supportedReasoningEfforts
    const values = Array.isArray(supported) ? supported.map(item => typeof item === 'string' ? item : item?.effort ?? item?.reasoning_effort ?? item?.reasoningEffort) : []
    return { model: row.slug, displayName: row.displayName, reasoningEfforts: efforts.filter(value => values.includes(value)) }
  }).filter(row => row.reasoningEfforts.length)
}
export function siwcError(error) {
  if (error instanceof DebateError) return error
  if (error instanceof StanceError) return new DebateError(error.code)
  const code = error?.code || ''
  if (['cancelled', 'AbortError'].includes(code)) return new DebateError('CANCELLED')
  if (['sign_in_required', 'reauth_required', 'invalid_grant', 'account_mismatch', 'invalid_id_token', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(code) || error?.status === 401) return new DebateError('CHATGPT_LOGIN_REQUIRED')
  if (/sharing.*limit|rate_limit|quota/.test(code) || error?.status === 429) return new DebateError('LIMIT')
  if (['sharing_not_enabled', 'subscription_sharing_user_not_eligible', 'chatpass_v2_scope_not_authorized', 'chatpass_v2_invalid_authorization_context'].includes(code)) return new DebateError('SHARING_REQUIRED')
  if (['invalid_request_error', 'model_not_found', 'unsupported_parameter', 'unsupported_value'].includes(code) || error?.status === 400) return new DebateError('UNSUPPORTED_MODEL_SETTINGS')
  if (code === 'timeout') return new DebateError('TIMEOUT')
  if (['network_error', 'connection_error'].includes(code)) return new DebateError('NETWORK')
  if (code === 'unexpected_output') return new DebateError('FORBIDDEN_TOOL')
  return new DebateError('AI_UNAVAILABLE')
}
export function createSIWCRuntime({ client, models, accountScope, getAccountScope, onAuthError = () => {}, onDiagnostic = () => {} }) {
  const lifetime = new AbortController()
  const stanceApproval = createStanceApproval()
  async function run(request, signal, feedback) {
    const combined = AbortSignal.any([signal, lifetime.signal])
    const settings = validateModelSettings(request.modelSettings, models, feedback ? 'feedback' : 'debate')
    try {
      combined.throwIfAborted()
      if (await getAccountScope() !== accountScope) throw new DebateError('CANCELLED')
      const started = performance.now()
      const check = async payload => {
        combined.throwIfAborted()
        if (await getAccountScope() !== accountScope) throw new DebateError('CANCELLED')
        const result = await client.streamResponse({ model: settings.model, reasoningEffort: settings.reasoningEffort, ...payload, signal: combined })
        combined.throwIfAborted()
        if (await getAccountScope() !== accountScope) throw new DebateError('CANCELLED')
        return result.text
      }
      if (!feedback) request = await stanceApproval.prepare(request, check)
      combined.throwIfAborted()
      console.info('[SIWC request] ' + JSON.stringify({ requestedModel: settings.model, reasoningEffort: settings.reasoningEffort, preset: settings.preset ?? 'legacy-manual', kind: feedback ? 'feedback' : 'debate' }))
      const response = await client.streamResponse({ model: settings.model, reasoningEffort: settings.reasoningEffort,
        outputSchema: feedback ? feedbackSchema : replySchema,
        ...(feedback ? buildFeedbackResponsesInput(request) : buildResponsesInput(request)), signal: combined })
      combined.throwIfAborted()
      if (await getAccountScope() !== accountScope) throw new DebateError('CANCELLED')
      const reply = feedback ? validateFeedbackReply(response.text, request) : validateReply(response.text, request)
      if (!feedback) await stanceApproval.approve(request, reply, check)
      combined.throwIfAborted()
      if (await getAccountScope() !== accountScope) throw new DebateError('CANCELLED')
      return { ...reply, ...settings,
        elapsedSeconds: Number(((performance.now() - started) / 1000).toFixed(3)) }
    } catch (error) {
      onDiagnostic({ kind: feedback ? 'feedback' : 'debate', code: /^[a-zA-Z_]{1,100}$/.test(error?.code) ? error.code : 'unknown', status: Number.isInteger(error?.status) ? error.status : undefined, name: /^[a-zA-Z]{1,40}$/.test(error?.name) ? error.name : undefined })
      if (combined.aborted) throw new DebateError('CANCELLED')
      const typed = siwcError(error)
      if (['CHATGPT_LOGIN_REQUIRED', 'SHARING_REQUIRED'].includes(typed.code)) onAuthError(typed.code)
      throw typed
    }
  }
  return { generate: (request, signal) => run(request, signal, false), analyze: (request, signal) => run(request, signal, true),
    cancel: () => lifetime.abort() }
}
