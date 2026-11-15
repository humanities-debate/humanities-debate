import { emptySpeech } from './types.ts'
import type { SpeechSnapshot } from './types.ts'
import type { PCMCapture } from './pcmCapture.ts'
import { MAX_INPUT_LENGTH } from '../logic/debate.ts'
import { previewWindow } from './previewWindow.ts'

export const PREVIEW_INTERVAL_MS = 2000
export const PREVIEW_SAMPLES = 16000 * 300
export const previewDelay = (processingMs: number) => Math.max(500, PREVIEW_INTERVAL_MS - processingMs)

export type LocalSpeechDependencies = {
  capture: (onInterrupted: () => void) => PCMCapture
  transcribe: (id: string, pcm: Uint8Array) => Promise<{ ok: true; text: string } | { ok: false; code: string }>
  cancel: (id: string) => Promise<void>
}
export function createLocalSpeechSession(deps: LocalSpeechDependencies, onChange: (snapshot: SpeechSnapshot) => void,
  seed = '', recovered: Pick<SpeechSnapshot, 'recoveryText' | 'overflowText'> = {}) {
  let snapshot: SpeechSnapshot = { ...emptySpeech, ...recovered, finalText: seed }
  let disposed = false, cancelled = false
  let startTask: Promise<void> = Promise.resolve()
  let startTimer: ReturnType<typeof setTimeout> | undefined
  let previewTimer: ReturnType<typeof setTimeout> | undefined
  let previewTask: Promise<void> | undefined
  let previewOffset = 0, previewPrefix = '', lastPreviewSamples = 0
  const id = crypto.randomUUID()
  const previewId = `${id}-preview`
  const valid = () => !disposed && !cancelled
  function emit(patch: Partial<SpeechSnapshot>) { snapshot = { ...snapshot, ...patch }; if (!disposed) onChange(snapshot) }
  const listening = () => valid() && snapshot.phase === 'listening'
  function schedulePreview(delay = PREVIEW_INTERVAL_MS) {
    if (!listening()) return
    previewTimer = setTimeout(() => {
      const started = performance.now()
      previewTask = updatePreview().finally(() => {
        previewTask = undefined
        // Start-to-start target, with a cooldown for CPU-heavy jobs; never queue inference.
        schedulePreview(previewDelay(performance.now() - started))
      })
    }, delay)
  }
  async function updatePreview() {
    if (!listening()) return
    try {
      const window = previewWindow(capture.preview(previewOffset, PREVIEW_SAMPLES))
      const pcm = window.pcm
      if (pcm.length < 16000 * 2 || pcm.length === lastPreviewSamples) return
      const result = await deps.transcribe(previewId, pcm)
      if (!listening()) return
      if (result.ok === false) throw new Error(result.code)
      const text = result.text.trim()
      const interimText = [previewPrefix, text].filter(Boolean).join(' ')
      // Replace the in-progress range; never deduplicate spoken words or commit previews.
      lastPreviewSamples = pcm.length
      if (window.consumeSamples) {
        previewOffset += window.consumeSamples
        previewPrefix = interimText
        lastPreviewSamples = 0
      }
      emit({ interimText, message: '듣고 있습니다. 임시 자막은 수정될 수 있습니다. 종료 후 전체 음성을 다시 인식하며, 발언 완료 전 내용을 확인할 수 있습니다.' })
    } catch {
      if (listening()) emit({ message: '녹음은 계속됩니다. 임시 자막 갱신이 지연됐습니다. 발언 종료 후 전체 음성을 변환합니다.' })
    }
  }
  async function clearPreview() {
    clearTimeout(previewTimer)
    await deps.cancel(previewId).catch(() => {})
    await previewTask
  }
  function fail(error: unknown) {
    if (!valid()) return
    const code = error instanceof Error ? error.message : 'ENGINE_FAILED'
    const denied = error instanceof Error && error.name === 'NotAllowedError'
    const deviceMissing = error instanceof Error && ['NotFoundError', 'NotReadableError'].includes(error.name)
    capture.cancel()
    clearTimeout(previewTimer)
    void deps.cancel(previewId).catch(() => {})
    emit({ phase: 'error', interimText: '', errorCode: denied ? 'not-allowed' : deviceMissing ? 'audio-capture' : 'local-recognition', message: denied
      ? '마이크 권한이 없습니다. Windows의 데스크톱 앱 마이크 권한을 확인하거나 텍스트로 입력해 주세요.'
      : deviceMissing ? '마이크를 열 수 없습니다. 장치 연결과 Windows의 기본 입력 장치를 확인하거나 텍스트로 입력해 주세요.'
      : code === 'TIMEOUT' ? '로컬 음성 변환 시간이 초과됐습니다. 더 짧게 말하거나 텍스트로 입력해 주세요.'
      : '마이크 또는 로컬 음성 변환에 문제가 생겼습니다. 입력한 글은 유지됩니다. 마이크 연결을 확인하고 다시 말하거나 텍스트로 입력해 주세요.' })
  }
  const capture = deps.capture(() => { if (valid() && snapshot.phase === 'listening') void stop('review') })
  async function stop(_intent: 'submit' | 'review') {
    void _intent
    if (!valid() || !['starting', 'listening'].includes(snapshot.phase)) return
    emit({ phase: 'stopping', message: '마이크를 닫고 PC에서 한국어로 변환합니다. 완료 후 내용을 확인해 주세요…' })
    await startTask
    if (!valid() || snapshot.phase === 'error') return
    try {
      const pcm = await capture.stop()
      await clearPreview()
      if (!valid()) return
      let text = ''
      if (pcm.byteLength) {
        const result = await deps.transcribe(id, pcm)
        if (!valid()) return
        if (result.ok === false) throw new Error(result.code)
        text = result.text.trim()
      }
      const combined = seed + (seed && text && !/\s$/.test(seed) ? ' ' : '') + text
      emit({ phase: 'review', interimText: '', finalText: combined.slice(0, MAX_INPUT_LENGTH), overflowText: combined.length > MAX_INPUT_LENGTH ? combined.slice(MAX_INPUT_LENGTH) : recovered.overflowText,
        message: text ? '로컬 변환이 끝났습니다. 잘못 인식한 부분을 수정한 뒤 발언 완료를 눌러주세요.' : '인식된 문장이 없습니다. 다시 말하거나 텍스트로 입력해 주세요.' })
      // Never auto-submit machine transcription: explicit user confirmation is required.
    } catch (error) { fail(error) }
  }
  return {
    start() {
      if (!valid() || snapshot.phase !== 'idle') return
      emit({ phase: 'starting', message: '로컬 음성 입력을 위한 마이크를 연결합니다.' })
      startTimer = setTimeout(() => { fail(new Error('START_TIMEOUT')); cancelled = true }, 15000)
      startTask = capture.start().then(() => {
        if (valid() && snapshot.phase === 'starting') {
          emit({ phase: 'listening', message: '듣고 있습니다. 잠시 후 임시 자막이 표시됩니다 (한 번에 최대 5분). 잠시 쉬어도 녹음은 계속됩니다.' })
          schedulePreview()
        }
      }).catch(fail).finally(() => clearTimeout(startTimer))
    },
    stop,
    cancel() {
      if (!valid()) return
      cancelled = true; clearTimeout(startTimer); capture.cancel(); void clearPreview(); void deps.cancel(id).catch(() => {})
      emit({ phase: 'review', interimText: '', message: '음성 입력을 취소했습니다. 아직 변환하지 않은 음성은 저장하지 않았습니다. 기존 글은 유지됩니다.' })
    },
    dispose() { disposed = true; cancelled = true; clearTimeout(startTimer); capture.cancel(); void clearPreview(); void deps.cancel(id).catch(() => {}) },
    getSnapshot: () => snapshot,
  }
}
