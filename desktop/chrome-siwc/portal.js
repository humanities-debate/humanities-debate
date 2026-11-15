// The Chrome window is the main app. Settings never owns the backend lifecycle.
const labels = { starting: '연결 준비 중', ready: 'ChatGPT 연결됨', 'login-required': 'ChatGPT 로그인 필요',
  'sharing-required': '구독 사용 동의 필요', 'logging-in': '로그인 진행 중', error: '연결 확인 필요' }
const details = { starting: '저장된 ChatGPT 연결을 확인하고 있습니다.', 'login-required': '본인 계정으로 로그인해 토론을 시작하세요. 인증이 만료됐다면 다시 로그인해 주세요.',
  'sharing-required': '공식 로그인 화면에서 본인 구독 사용에 동의해 주세요.', 'logging-in': '공식 브라우저에서 로그인·동의를 완료해 주세요. 완료하면 토론 화면이 자동으로 열립니다.',
  error: '다시 연결하거나 공식 ChatGPT 로그인으로 복구해 주세요.' }
const messages = {
  account_mismatch: '이 연결과 다른 계정입니다. 기존 기록은 유지됩니다. 설정의 다른 계정 추가를 이용해 주세요.',
  CHATGPT_LOGIN_REQUIRED: '인증을 갱신하지 못했습니다. Continue with ChatGPT로 다시 로그인해 주세요.',
  SHARING_REQUIRED: '선택한 계정의 구독 사용 권한을 확인하고 다시 로그인해 주세요.',
  network_error: 'OpenAI에 연결하지 못했습니다. 네트워크 확인 후 다시 연결을 누르세요.',
  revocation_failed: '로컬 로그아웃은 처리됐지만 원격 연결 해제는 확인되지 않았습니다. 설정의 사용량 관리에서 접근을 해제해 주세요.',
  MODELS_UNAVAILABLE: '계정의 지원 모델 설정을 확인하지 못했습니다. 다른 모델로 자동 대체하지 않습니다.',
  subscription_sharing_user_not_eligible: '선택한 계정·작업공간에서 구독 사용이 허용되지 않습니다.',
  access_denied: '로그인 또는 구독 사용 동의가 취소되었습니다.',
  LEGACY_CLOSE_OLD_APP_OR_NOT_FOUND: '기존 0.0.7 앱을 종료한 뒤 다시 시도해 주세요. 같은 Windows 사용자·프로필의 기존 기록 경로가 필요합니다.',
  storage_encryption_unavailable: 'Windows 보호 저장소를 사용할 수 없습니다. 저장된 인증은 보존했습니다.',
}
const transitions = new Set(['login', 'logout', 'add-account', 'select-account', 'reconnect'])
export async function startPortal({ document, location, history, fetch, setInterval, clearInterval, confirm, window }) {
  const get = id => document.querySelector('#' + id)
  const state = get('status'), frame = document.querySelector('iframe'), error = get('error'), picker = get('accounts')
  const panel = get('settings-panel'), toggle = get('settings-toggle'), connection = get('connection-view')
  const buttons = [...document.querySelectorAll('[data-action]')]
  const headers = { 'X-Launch-Client': 'local-ui', 'Content-Type': 'application/json' }
  let phase = 'starting', busy = false, loaded = false, updating = false, epoch = 0, disposed = false, accountSignature, actionError = ''
  let current = { phase: 'starting', accounts: [] }
  function menu(show) { panel.hidden = !show; toggle.setAttribute('aria-expanded', String(show)); (show ? get('settings-close') : toggle).focus() }
  function clearFrame() { if (loaded) frame.src = 'about:blank'; frame.hidden = true; loaded = false }
  function render(next) {
    current = next; phase = next.phase
    const ready = phase === 'ready'
    state.textContent = labels[phase] || '연결 확인 필요'
    get('connection-title').textContent = labels[phase] || '연결 확인 필요'
    get('connection-detail').textContent = details[phase] || details.error
    connection.hidden = ready
    if (!ready) clearFrame()
    else if (!loaded && !busy) { frame.src = '/app'; frame.hidden = false; loaded = true }
    error.textContent = actionError || (next.error ? messages[next.error] || `연결 문제: ${next.error}` : next.revocation === 'confirmed' && phase === 'login-required' ? '로그아웃했습니다. 기록은 보존됩니다.' : '')
    const account = next.activeAccount
    get('account-info').textContent = account ? `${account.label}${account.email ? ` · ${account.email}` : ''}` : '로그인된 계정이 없습니다.'
    const signature = JSON.stringify([next.accounts, account?.id])
    if (signature !== accountSignature) {
      picker.replaceChildren()
      for (const item of next.accounts || []) {
        const option = document.createElement('option'); option.value = item.id
        option.textContent = `${item.label}${item.email ? ` (${item.email})` : ''}${item.pending ? ' · 등록 대기' : item.status !== 'connected' ? ' · 재로그인' : ''}`
        option.disabled = item.pending; option.selected = item.id === account?.id; picker.append(option)
      }
      accountSignature = signature
    }
    const pending = busy || ['starting', 'logging-in'].includes(phase)
    get('primary-login').hidden = !['login-required', 'sharing-required', 'error'].includes(phase)
    get('primary-reconnect').hidden = !['login-required', 'sharing-required', 'error'].includes(phase)
    get('cancel-login').hidden = phase !== 'logging-in'
    for (const button of buttons) button.disabled = pending && !['cancel-login', 'exit'].includes(button.dataset.action)
    get('record-tools').disabled = !ready || pending
    picker.disabled = pending || !next.accounts?.length
    for (const button of buttons.filter(item => item.dataset.action === 'select-account')) button.disabled ||= !next.accounts?.some(item => !item.pending)
    for (const button of buttons.filter(item => item.dataset.action === 'logout')) button.disabled ||= !account
  }
  async function update() {
    if (disposed || updating) return
    updating = true
    const requestEpoch = epoch
    try {
      const response = await fetch('/launcher/status', { headers })
      if (!response.ok) throw new Error('STATUS_FAILED')
      const next = await response.json()
      if (!disposed && requestEpoch === epoch) render(next)
    } catch {
      if (!disposed && requestEpoch === epoch) {
        clearFrame(); actionError = '연결이 종료되었거나 확인되지 않습니다. 실행 아이콘으로 다시 시작해 주세요.'
        render({ ...current, phase: 'error' })
      }
    } finally { updating = false }
  }
  toggle.onclick = () => menu(panel.hidden)
  get('settings-close').onclick = () => menu(false)
  const keydown = event => { if (event.key === 'Escape' && !panel.hidden) menu(false) }
  document.addEventListener('keydown', keydown)
  get('record-tools').onclick = () => { if (loaded && phase === 'ready') { actionError = ''; menu(false); frame.contentWindow.postMessage({ type: 'humanities-debate:open-record-tools' }, location.origin) } }
  const recordMessage = event => {
    if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.type !== 'humanities-debate:record-tools-busy') return
    actionError = '진행 중인 토론을 먼저 종료·저장한 뒤 기록 백업·복원을 열어 주세요.'; error.textContent = actionError
  }
  window.addEventListener('message', recordMessage)
  for (const button of buttons) button.onclick = async () => {
    const name = button.dataset.action
    if (disposed || (busy && !['cancel-login', 'exit'].includes(name))) return
    if (name === 'select-account' && phase === 'ready' && picker.value === current.activeAccount?.id) { menu(false); return }
    if (transitions.has(name) && loaded && !confirm('계정 연결을 변경하면 진행 중 토론과 미확정 입력이 중단됩니다. 토론을 종료·저장한 뒤 진행해 주세요. 계속할까요?')) return
    if (name === 'logout' && !confirm('원격 연결 해제를 시도하고 로그아웃합니다. 저장된 기록은 유지합니다. 계속할까요?')) return
    if (name === 'recover-legacy' && !confirm('기존 0.0.7 앱을 먼저 종료하세요. 본인의 기존 기록만 읽는 백업 창을 열까요?')) return
    busy = true; actionError = ''; epoch++
    if (transitions.has(name) || name === 'exit') { clearFrame(); menu(false); render({ ...current, phase: ['login', 'add-account'].includes(name) ? 'logging-in' : 'starting' }) }
    try {
      const response = await fetch(`/launcher/${name}`, { method: 'POST', headers, body: JSON.stringify({ profileId: picker.value }) })
      const data = await response.json()
      if (!response.ok || data.error) actionError = messages[data.error] || `작업 실패: ${data.error || response.status}`
    } catch { actionError = '작업 결과를 확인하지 못했습니다. 연결 상태를 확인해 주세요.' }
    finally { busy = false; await update() }
  }
  const capability = location.hash.slice(1)
  history.replaceState(null, '', '/')
  try {
    if (capability && !(await fetch('/launcher/claim', { method: 'POST', headers: { 'X-Launch-Capability': capability } })).ok) throw new Error('CLAIM_FAILED')
    await update()
  } catch { actionError = '이 실행의 연결 권한을 확인하지 못했습니다. 프로그램을 다시 실행해 주세요.'; render({ ...current, phase: 'error' }) }
  const timer = setInterval(update, 2000)
  function dispose() { disposed = true; epoch++; clearInterval(timer); document.removeEventListener('keydown', keydown); window.removeEventListener('message', recordMessage) }
  window.addEventListener('pagehide', dispose, { once: true })
  return { update, dispose }
}
if (typeof document !== 'undefined') void startPortal({ document, location, history, fetch, setInterval, clearInterval, confirm, window })
