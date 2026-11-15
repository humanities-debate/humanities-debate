import path from 'node:path'

export const APP_URL = 'debate://app/'
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'"
export function isAppUrl(value) {
  try { const url = new URL(value); return url.protocol === 'debate:' && url.host === 'app' && !url.username && !url.password } catch { return false }
}
export function assetPath(root, input) {
  if (!isAppUrl(input)) return null
  const url = new URL(input)
  let name
  try { name = decodeURIComponent(url.pathname) } catch { return null }
  if (name.includes('\\') || name.includes('\0') || name.includes(':')) return null
  if (name === '/') name = '/index.html'
  const target = path.resolve(root, '.' + name)
  return target.startsWith(path.resolve(root) + path.sep) ? target : null
}
export function apiAllowed(method, pathname) {
  return method === 'GET' ? ['/api/session', '/api/models'].includes(pathname)
    : method === 'POST' && ['/api/turn', '/api/feedback', '/api/cancel'].includes(pathname)
}
export function permissionAllowed(permission, url, mediaTypes = []) {
  return isAppUrl(url) && (permission === 'clipboard-sanitized-write' ||
    (permission === 'media' && mediaTypes.length > 0 && mediaTypes.every(type => type === 'audio')))
}
export function statusMessage(code) {
  return ({ CHATGPT_LOGIN_REQUIRED: '이 앱에서 자신의 ChatGPT 계정으로 로그인해 주세요.',
    CLI_VERSION: '포함된 Codex 실행 파일 버전이 맞지 않습니다. 앱을 다시 설치해 주세요.',
    RUNTIME_PERMISSIONS: '사용자 데이터 폴더의 권한을 설정하지 못했습니다.',
    MODELS_UNAVAILABLE: '모델 목록을 확인하지 못했습니다. 로그인과 네트워크를 확인한 뒤 다시 연결해 주세요.',
    LOGIN_FAILED: '로그인이 완료되지 않았습니다. 브라우저와 네트워크를 확인하고 다시 시도해 주세요.',
    LOGIN_TIMEOUT: '로그인 대기 시간이 지났습니다. 다시 로그인해 주세요.',
    BACKEND_EXIT: 'AI 서버가 중단되었습니다. 기록은 유지됩니다. 토론을 멈추고 다시 연결해 주세요.',
  })[code] || 'AI 서버 준비에 실패했습니다. 다시 연결하거나 앱을 재실행해 주세요.'
}
