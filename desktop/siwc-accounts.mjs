import { createHash } from 'node:crypto'
import path from 'node:path'

export const SIWC_APP_NAME = 'Humanities Debate'
export const validProfile = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,40}$/.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)
export function siwcPaths({ root, appData, packaged, profile }) {
  if (!validProfile(profile)) throw new Error('INVALID_PROFILE')
  const dataRoot = path.join(packaged ? path.join(appData, 'HumanitiesDebateSIWC/profiles') : path.join(root, '.codex-debate/siwc-8f'), profile)
  return { dataRoot, auth: path.join(dataRoot, 'official-auth'), launcher: path.join(dataRoot, 'launcher'),
    guest: path.join(dataRoot, 'guest'), accounts: path.join(dataRoot, 'accounts'),
    legacy: path.join(packaged ? path.join(appData, 'HumanitiesDebateChrome/profiles') : path.join(root, '.codex-debate/chrome-prototype'), profile) }
}
export function accountScope(saved, session) {
  const profile = saved?.profiles?.find(item => item.id === saved.activeProfileId)
  if (session?.status !== 'connected' || !session.sharing || session.profileId !== profile?.id ||
      profile.status !== 'connected' || !profile.subject || !profile.clientId || profile.clientId === 'dynamic_agent_client' ||
      !profile.credentials || profile.pendingRefresh || !profile.scopes.includes('chatgpt.tokens.use.direct')) throw new Error('VERIFIED_ACCOUNT_REQUIRED')
  // Subject was signature/issuer/audience/nonce-validated by the official SDK.
  // The registration (workspace boundary) is part of the key; email never is.
  return createHash('sha256').update(JSON.stringify(['https://auth.openai.com', profile.subject, profile.clientId])).digest('hex')
}
export function publicAccounts(profiles) {
  return profiles.map(item => ({ id: item.id, label: item.label, status: item.status,
    sharing: item.sharing === true, pending: item.pending === true,
    ...(typeof item.identity?.email === 'string' ? { email: item.identity.email } : {}) }))
}
export function publicAuthError(error) {
  const code = error?.code || error?.message
  return /^[a-zA-Z_]{1,100}$/.test(code) ? code : 'CONNECTION_FAILED'
}
