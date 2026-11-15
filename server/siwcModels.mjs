// SPDX-License-Identifier: LicenseRef-SIWC-DevKit-Noncommercial-1.0
// Modified DevKit module, Humanities Debate contributors, 2026-11-15.
// Original: OpenAI Sign in with ChatGPT DevKit. See licenses/DEVKIT_LICENSE.txt.
// Changes: account catalog capabilities and safe errors; auth source is unchanged.
// Selected account's live catalog. Retain only non-sensitive capability metadata.
export async function listModels(accessToken, signal) {
  const { ChatGPTError } = await import('@siwc-internal/errors')
  try {
  const response = await fetch('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: 'error' })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const code = body?.error?.code
    throw new ChatGPTError(typeof code === 'string' && /^[a-zA-Z_]{1,100}$/.test(code) ? code : 'model_list_failed', 'MODEL_LIST_FAILED', false, response.status)
  }
  if (!Array.isArray(body?.models)) throw new ChatGPTError('invalid_model_catalog', 'INVALID_CATALOG')
  return body.models.filter(item => item.visibility === 'list' && typeof item.slug === 'string' && item.slug.length < 200)
    .map(item => ({ slug: item.slug, displayName: typeof item.display_name === 'string' ? item.display_name : item.slug,
      supportedReasoningEfforts: item.supported_reasoning_levels ?? item.supported_reasoning_efforts ?? [],
      defaultReasoningEffort: item.default_reasoning_level ?? item.default_reasoning_effort }))
  } catch (error) {
    if (error instanceof ChatGPTError) throw error
    throw new ChatGPTError(signal.aborted ? 'cancelled' : 'network_error', 'MODEL_LIST_FAILED', true)
  }
}
