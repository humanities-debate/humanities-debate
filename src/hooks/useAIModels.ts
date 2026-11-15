import { useEffect, useState } from 'react'
import type { Dispatch } from 'react'
import type { DebateAction } from '../logic/debate'
import type { ModelCatalog } from '../types/debate'
import { presetSettings } from '../config/aiPresets'
import type { DesktopStatus } from '../desktop'

export function useAIModels(dispatch: Dispatch<DebateAction>) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const [desktopReady, setDesktopReady] = useState(!window.debateDesktop)
  useEffect(() => {
    const desktop = window.debateDesktop
    if (!desktop) return
    let active = true
    const update = (status: DesktopStatus) => {
      if (!active) return
      setDesktopReady(status.phase === 'ready')
      if (status.phase === 'ready') { setLoading(true); setRevision(value => value + 1) }
      else { setCatalog(null); setLoading(false); setError(status.message) }
    }
    const unsubscribe = desktop.onStatus(update)
    void desktop.status().then(update).catch(() => { if (active) setError('앱 연결 상태를 확인하지 못했습니다.') })
    return () => { active = false; unsubscribe() }
  }, [])
  useEffect(() => {
    if (!desktopReady) return
    const controller = new AbortController()
    void fetch('/api/models', { headers: { 'X-Debate-Client': 'local-ui' }, cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) })
      .then(async response => {
        if (!response.ok) throw new Error('Models unavailable')
        const data = await response.json() as ModelCatalog
        if (!Array.isArray(data.models) || !data.models.length || !data.models.every(item => typeof item.model === 'string' && typeof item.displayName === 'string' &&
          Array.isArray(item.reasoningEfforts) && item.reasoningEfforts.length && item.reasoningEfforts.every(effort => ['low', 'medium', 'high'].includes(effort))) ||
          !data.models.some(item => item.model === data.defaultSettings?.model && item.reasoningEfforts.includes(data.defaultSettings.reasoningEffort))) throw new Error('Invalid model catalog')
        if (controller.signal.aborted) return
        setCatalog(data)
        setError(null)
        dispatch({ type: 'MODEL_DEFAULT', settings: presetSettings('debate-standard') })
      }).catch(() => {
        if (!controller.signal.aborted) {
          setCatalog(null)
          setError('모델 목록을 불러오지 못했습니다. AI 서버를 실행한 뒤 목록을 다시 확인해 주세요. Mock은 사용할 수 있습니다.')
        }
      }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [dispatch, revision, desktopReady])
  return { catalog, error, loading, reload: () => { setLoading(true); setError(null); setRevision(value => value + 1) } }
}
