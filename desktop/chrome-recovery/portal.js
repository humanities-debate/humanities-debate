const capability = location.hash.slice(1)
history.replaceState(null, '', '/')
if (capability) await fetch('/launcher/claim', { method: 'POST', headers: { 'X-Launch-Capability': capability } })
const status = document.querySelector('#status')
document.querySelector('#backup').onclick = () => {
  try {
    const items = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith('skhynix-debate:record:')) items.push({ key, value: localStorage.getItem(key) })
    }
    if (!items.length) { status.textContent = '이 프로필에서 저장된 토론 기록을 찾지 못했습니다. 원본 저장소는 변경하지 않았습니다.'; return }
    const blob = new Blob([JSON.stringify({ format: 'humanities-debate-backup', version: 1, ownership: 'unassigned', createdAt: new Date().toISOString(), items }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob), anchor = document.createElement('a')
    anchor.href = url; anchor.download = 'humanities-debate-legacy-backup.json'; anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    status.textContent = `${items.length}개 원본 기록의 백업 파일 저장을 요청했습니다. 다운로드 폴더에서 파일을 확인해 주세요. 기존 기록은 유지했습니다.`
  } catch { status.textContent = '백업하지 못했습니다. 원본은 보존됩니다. 저장 권한을 확인해 주세요.' }
}
