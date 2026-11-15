import { createHash } from 'node:crypto'

export const ISSUER = 'https://auth.openai.com'
export const APP_NAME = 'Humanities Debate SIWC Prototype'
export const SMOKE_QUESTION = '인문학 토론 연습용 질문 하나를 한국어 한 문장으로 제안해 주세요.'

export function prototypeEnvironment(source) {
  const allowed = new Set(['systemroot', 'windir', 'path', 'pathext', 'userprofile', 'appdata', 'localappdata', 'temp', 'tmp'])
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => allowed.has(key.toLowerCase()) && typeof value === 'string'))
}
export function allowedBrowserUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
    !((url.origin === ISSUER && url.pathname === '/api/accounts/authorize') ||
      (url.origin === 'https://chatgpt.com' && url.pathname === '/settings/usage'))) throw new Error('UNSAFE_BROWSER_URL')
  return url.href
}
// The official SDK verified the ID token before writing this protected store.
// This function does not decode a JWT or independently verify an arbitrary identity.
export function verifiedRecordScope(saved, session) {
  const profile = saved?.profiles?.find(item => item.id === saved.activeProfileId)
  if (session.status !== 'connected' || !session.sharing || profile?.id !== session.profileId ||
      profile?.status !== 'connected' || !profile.subject || !profile.credentials ||
      !profile.scopes?.includes('chatgpt.tokens.use.direct') || !profile.clientId ||
      profile.clientId === 'dynamic_agent_client' || profile.pendingRefresh) throw new Error('VERIFIED_ACCOUNT_REQUIRED')
  return createHash('sha256').update(JSON.stringify([ISSUER, profile.subject, profile.clientId])).digest('hex')
}
export function publicSession(session) {
  return { status: session.status, sharing: session.sharing === true,
    ...(session.profileId ? { profileId: session.profileId } : {}),
    ...(session.profileLabel ? { label: session.profileLabel } : {}) }
}
export function safeError(error) {
  const code = typeof error?.code === 'string' && /^[a-zA-Z_]{1,80}$/.test(error.code) ? error.code :
    typeof error?.message === 'string' && /^[A-Z_]{1,80}$/.test(error.message) ? error.message : 'PROTOTYPE_FAILED'
  return { code, ...(Number.isInteger(error?.status) ? { status: error.status } : {}) }
}
export function selectSmokeModel(models) {
  return ['gpt-6-luna', 'gpt-6.1-sol'].map(id => models.find(item => item.slug === id)).find(Boolean) ?? models[0]
}

// One explicit test request per process. Do not queue clicks or retry failed inference.
export function onceOnlySmoke(invoke) {
  let attempted = false
  return async options => {
    if (attempted) throw new Error('SMOKE_ALREADY_ATTEMPTED')
    attempted = true
    return invoke(options)
  }
}
