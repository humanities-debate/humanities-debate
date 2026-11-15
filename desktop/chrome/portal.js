const state = document.querySelector('#status')
const frame = document.querySelector('iframe')
const labels = { starting: 'AI 서버 준비 중', ready: '본인 ChatGPT 인증 연결 준비 완료', 'login-required': 'ChatGPT 로그인이 필요합니다', 'logging-in': '기본 브라우저에서 로그인해 주세요', error: '연결 실패: 다시 연결하거나 로그인해 주세요' }
const headers = { 'X-Launch-Client': 'local-ui' }
const capability = location.hash.slice(1)
history.replaceState(null, '', '/')
if (capability) await fetch('/launcher/claim', { method: 'POST', headers: { 'X-Launch-Capability': capability } })
let phase
async function update() {
  try {
    const response = await fetch('/launcher/status', { headers })
    if (!response.ok) throw new Error()
    const next = await response.json()
    state.textContent = `${next.profile} · ${labels[next.phase] || '연결 확인 중'}`
    if (next.phase !== 'ready' && phase === 'ready') { frame.src = 'about:blank'; frame.hidden = true }
    phase = next.phase
    for (const button of document.querySelectorAll('[data-action]')) button.disabled = ['starting', 'logging-in'].includes(phase) && !['exit', 'cancel-login'].includes(button.dataset.action)
  } catch { state.textContent = '연결이 종료되었습니다. 실행 아이콘으로 다시 시작해 주세요.' }
}
document.querySelector('#open').onclick = () => { frame.src = '/app'; frame.hidden = false }
for (const button of document.querySelectorAll('[data-action]')) button.onclick = async () => {
  const name = button.dataset.action
  if (name === 'logout' && !confirm('진행 중 토론은 중단됩니다. 이 프로필의 로컬 인증만 지우고 기록은 보존합니다. 원격 세션 해제와 다른 계정 기록 분리는 별도입니다. 계속할까요?')) return
  if (['login', 'logout', 'reconnect', 'exit'].includes(name)) { frame.src = 'about:blank'; frame.hidden = true }
  button.disabled = true
  try { const response = await fetch(`/launcher/${name}`, { method: 'POST', headers }); if (!response.ok) state.textContent = '작업에 실패했습니다. 다시 시도해 주세요.' }
  finally { button.disabled = false; await update() }
}
await update()
setInterval(update, 2000)
