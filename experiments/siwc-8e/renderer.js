const bridge = window.siwcPrototype
const byId = id => document.getElementById(id)
let busy = false, attempted = false, sharing = false
function controls() {
  for (const button of document.querySelectorAll('button')) button.disabled = busy && button.dataset.action !== 'cancel'
  byId('smoke').disabled = busy || attempted || !sharing || !byId('models').value
  byId('profiles').disabled = busy
  byId('models').disabled = busy || attempted
}
function session(value) {
  sharing = value.sharing
  const states = { connected: '공식 로그인 연결됨', connecting: '브라우저에서 계정 선택과 동의를 완료하세요', disconnected: '로그인 필요', reauth_required: '재로그인 필요' }
  byId('session').textContent = `${states[value.status] || value.status} · 구독 사용 동의: ${sharing ? '확인' : '미확인'}`
  controls()
}
function choices(element, entries, selected) {
  element.replaceChildren()
  for (const entry of entries) {
    const option = document.createElement('option'); option.value = entry.id; option.textContent = entry.label
    element.append(option)
  }
  if (selected) element.value = selected
}
function render(value) {
  if (value.session) session(value.session)
  if (value.profiles) choices(byId('profiles'), value.profiles.filter(item => !item.pending), value.session?.profileId)
  if (value.models) choices(byId('models'), value.models.map(item => ({ id: item.slug, label: item.displayName })), value.preferredModel)
  attempted = value.smokeAttempted ?? attempted
  if (value.report?.inference === 'SUCCESS') byId('result').textContent = `${value.report.text}\n\n요청 모델: ${value.report.requestedModel}\n소요 시간: ${value.report.elapsedSeconds}초\nSDK는 실제 처리 모델을 별도로 보고하지 않습니다.`
  if (value.error) {
    const help = value.error.code === 'revocation_failed' ? '로컬 로그아웃은 처리됐지만 원격 철회는 확인되지 않았습니다. ChatGPT 설정에서 연결을 해제하세요.' : '요청을 완료하지 못했습니다. 인증·권한·네트워크 상태를 확인하세요.'
    byId('message').textContent = `${help} 오류 코드: ${value.error.code}${value.error.status ? ` (HTTP ${value.error.status})` : ''}`
  }
  controls()
}
for (const button of document.querySelectorAll('button')) button.addEventListener('click', async () => {
  const action = button.dataset.action
  if (busy && action !== 'cancel') return
  if (action === 'cancel') { await bridge.action({ action }); return }
  busy = true; controls(); byId('message').textContent = ''
  try { render(await bridge.action({ action, model: byId('models').value, profileId: byId('profiles').value })) }
  catch { byId('message').textContent = '프로토타입 연결 오류입니다. 기존 앱에는 영향을 주지 않습니다.' }
  finally { busy = false; controls() }
})
byId('models').addEventListener('change', controls)
bridge.onState(session)
bridge.action({ action: 'status' }).then(render).catch(() => { byId('message').textContent = '프로토타입을 준비하지 못했습니다.' })
