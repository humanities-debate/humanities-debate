import { MAX_INPUT_LENGTH } from '../logic/debate.ts'
import { emptySpeech, speechBusy } from './types.ts'
import type { Recognition, RecognitionEvent, RecognitionFactory, SpeechDiagnostic, SpeechSnapshot } from './types.ts'

export const STOP_TIMEOUT_MS = 4000
export const START_TIMEOUT_MS = 15000
export const RESTART_DELAY_MS = 600
export const MAX_RESTARTS = 2
// Count rapid, unproductive disconnections, not the lifetime number of Chrome sessions.
// A real result or a sustained listening session starts a fresh failure budget.
export const HEALTHY_LISTEN_MS = 5000
export const MAX_DIAGNOSTICS = 24

export function speechErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    'not-allowed': '마이크 권한이 거부되었습니다. Chrome 사이트 설정과 Windows 마이크 권한을 확인하거나 텍스트로 입력해 주세요.',
    'service-not-allowed': '브라우저에서 음성 인식 서비스를 허용하지 않습니다. 텍스트 입력을 이용해 주세요.',
    'audio-capture': '사용 가능한 마이크를 찾지 못했습니다. 장치 연결과 기본 입력 장치를 확인해 주세요.',
    network: '음성 인식 서비스에 연결하지 못했습니다. 네트워크를 확인하거나 텍스트로 입력해 주세요.',
    'language-not-supported': '이 브라우저의 한국어 음성 인식을 사용할 수 없습니다. 텍스트로 입력해 주세요.',
    aborted: '음성 인식이 중단되었습니다. 확정된 문장을 확인하고 다시 말하거나 텍스트로 이어서 입력해 주세요.',
    'start-conflict': '음성 인식이 이미 실행 중이거나 화면이 활성 상태가 아닙니다. 다른 마이크 창을 닫고 마이크 다시 켜기를 눌러주세요.',
  }
  return messages[code] ?? '음성 인식 중 오류가 발생했습니다. 확정된 문장을 유지했으니 텍스트로 이어서 입력해 주세요.'
}
function join(parts: string[]) { return parts.map(part => part.trim()).filter(Boolean).join(' ') }

// Each explicit microphone start owns its instances and timers. Old callbacks are invalidated
// before abort(), which can synchronously produce more browser events.
export function createSpeechSession(
  factory: RecognitionFactory | null,
  onChange: (snapshot: SpeechSnapshot) => void,
  onFinish: (text: string) => void,
  seed = '',
  recovered: Pick<SpeechSnapshot, 'recoveryText' | 'overflowText'> = {},
) {
  let snapshot: SpeechSnapshot = { ...emptySpeech, ...recovered, finalText: seed }
  let current: Recognition | null = null
  let disposed = false
  let restarts = 0
  let attempt = 0
  const startedAt = Date.now()
  let stopIntent: 'submit' | 'review' | null = null
  let waitingAfterSilence = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined }
  const emit = (patch: Partial<SpeechSnapshot>) => {
    snapshot = { ...snapshot, ...patch }
    if (!disposed) onChange(snapshot)
  }
  // Memory-only, bounded metadata. Never retain audio, transcripts, browser error messages,
  // URLs, profile paths or authentication data in diagnostics.
  const trace = (event: SpeechDiagnostic['event'], code?: string) => emit({ diagnostics: [
    ...(snapshot.diagnostics ?? []), { event, attempt, elapsedMs: Math.max(0, Date.now() - startedAt), ...(code ? { code } : {}) },
  ].slice(-MAX_DIAGNOSTICS) })
  function detach(abort: boolean) {
    const recognition = current
    current = null
    if (!recognition) return
    recognition.onstart = recognition.onresult = recognition.onerror = recognition.onend = null
    recognition.onaudiostart = null
    if (abort) { try { recognition.abort() } catch { /* Already disconnected. */ } }
  }
  function fail(message: string, errorCode = 'recognition-error') {
    clearTimer()
    stopIntent = null
    detach(true)
    emit({ phase: 'error', message, errorCode })
  }
  function complete() {
    const intent = stopIntent
    stopIntent = null
    clearTimer()
    detach(false)
    const uncertain = Boolean(snapshot.interimText.trim() || snapshot.recoveryText?.trim() || snapshot.overflowText)
    emit({ phase: 'review', message: uncertain
      ? '확정되지 않은 임시 문장 또는 입력 한도 초과분이 남았습니다. 기록에서 제외되는 내용을 확인하고 필요한 부분을 직접 편집한 뒤 발언 완료를 눌러주세요.'
      : snapshot.message || (snapshot.finalText.trim()
        ? intent === 'submit' ? '음성 인식이 종료되었습니다.' : '인식이 끝났습니다. 내용을 수정하거나 발언 완료를 눌러주세요.'
        : '인식된 발언이 없어 저장하지 않았습니다. 다시 말하거나 텍스트로 입력할 수 있습니다.') })
    if (intent === 'submit' && !uncertain && !disposed) onFinish(snapshot.finalText)
  }
  function stop(intent: 'submit' | 'review') {
    if (disposed || snapshot.phase === 'stopping' || !speechBusy(snapshot.phase)) return
    clearTimer()
    stopIntent = intent
    trace('stop-request')
    emit({ phase: 'stopping', message: '마지막 인식 결과를 기다리고 있습니다…' })
    if (!current) { emit({ message: '' }); complete(); return }
    timer = setTimeout(() => fail('음성 인식 종료 응답이 늦어 마이크를 중단했습니다. 확정된 문장을 확인하고 직접 발언 완료를 눌러주세요.'), STOP_TIMEOUT_MS)
    try { current.stop() } catch { fail('마이크를 정상적으로 종료하지 못했습니다. 확정된 문장을 확인하고 텍스트로 이어서 입력해 주세요.') }
  }
  function open() {
    if (disposed || !factory || current || stopIntent) return
    clearTimer()
    attempt++
    const base = snapshot.finalText
    const finals = new Map<number, string>()
    let listeningSince: number | undefined
    let receivedFinal = false, receivedInterim = false
    let lastError: 'no-speech' | 'aborted' | undefined
    let recognition: Recognition
    try { recognition = factory() } catch { fail('음성 인식을 초기화하지 못했습니다. 텍스트 입력을 이용해 주세요.'); return }
    current = recognition
    const valid = () => !disposed && current === recognition
    recognition.lang = 'ko-KR'
    recognition.continuous = true
    recognition.interimResults = true
    recognition.onstart = () => {
      if (!valid() || stopIntent) return
      clearTimer()
      listeningSince = Date.now()
      waitingAfterSilence = false
      trace('start')
      emit({ phase: 'listening', message: '듣고 있습니다. 잠시 쉬어도 발언이 자동 제출되지 않습니다.' })
    }
    recognition.onaudiostart = () => { if (valid()) trace('audio-start') }
    recognition.onresult = (event: RecognitionEvent) => {
      if (!valid()) return
      if (waitingAfterSilence && !stopIntent) { clearTimer(); waitingAfterSilence = false }
      const interim: string[] = []
      // Full result list is cumulative within one instance. Final indices are stored once.
      for (let index = 0; index < event.results.length; index++) {
        const result = event.results[index]
        if (result.isFinal) {
          const value = result[0]?.transcript ?? ''
          if (!finals.has(index) && value.trim()) finals.set(index, value)
        } else if (!finals.has(index)) interim.push(result[0]?.transcript ?? '')
      }
      const addition = join([...finals].sort(([a], [b]) => a - b).map(([, value]) => value))
      if (addition && !receivedFinal) { receivedFinal = true; trace('final-result') }
      if (join(interim) && !receivedInterim) { receivedInterim = true; trace('interim-result') }
      const text = addition ? base + (base && !/\s$/.test(base) ? ' ' : '') + addition : base
      emit({ finalText: text.slice(0, MAX_INPUT_LENGTH), interimText: join(interim),
        overflowText: text.length > MAX_INPUT_LENGTH ? text.slice(MAX_INPUT_LENGTH) : snapshot.overflowText })
      if (text.length >= MAX_INPUT_LENGTH && !stopIntent) {
        stop('review')
        emit({ message: '발언 입력 한도 4,000자에 도달했습니다. 확정된 내용을 확인하고 제출해 주세요.' })
      }
    }
    recognition.onerror = ({ error }) => {
      if (!valid()) return
      // Use a fixed whitelist; browser/vendor error messages are never logged or displayed.
      const code = ['no-speech', 'aborted', 'audio-capture', 'network', 'not-allowed', 'service-not-allowed', 'language-not-supported'].includes(error) ? error : 'recognition-error'
      trace('error', code)
      if (code === 'no-speech' && !stopIntent) {
        clearTimer()
        lastError = code
        waitingAfterSilence = true
        emit({ message: '아직 음성이 인식되지 않았습니다. 사용자 차례를 유지합니다.' })
        timer = setTimeout(() => fail('음성이 감지되지 않은 뒤 종료 응답이 오지 않았습니다. 마이크를 다시 켜거나 텍스트로 입력해 주세요.', 'no-speech'), STOP_TIMEOUT_MS)
        return
      }
      if (code === 'no-speech' && stopIntent) return
      if (code === 'aborted' && stopIntent) {
        // A browser abort during explicit stop cannot promise a final result: review only.
        // Keep the stop watchdog and wait for end, without restarting or auto-submitting.
        lastError = code
        stopIntent = 'review'
        emit({ message: '브라우저가 인식을 중단했습니다. 확정된 내용과 남은 임시 문장을 확인한 뒤 발언 완료를 눌러주세요.' })
        return
      }
      fail(speechErrorMessage(code), code)
    }
    recognition.onend = () => {
      if (!valid()) return
      clearTimer()
      trace('end', stopIntent ? 'user-stop' : lastError ?? 'service-disconnected')
      detach(false)
      if (stopIntent) {
        emit({ message: snapshot.message === '마지막 인식 결과를 기다리고 있습니다…' ? '' : snapshot.message })
        complete()
        return
      }
      if (snapshot.interimText.trim()) {
        fail('인식이 중단되어 임시 문장이 확정되지 않았습니다. 내용을 확인하고 텍스트로 보완해 주세요.', 'unconfirmed-result')
        return
      }
      const healthy = receivedFinal || (listeningSince !== undefined && Date.now() - listeningSince >= HEALTHY_LISTEN_MS)
      if (healthy) restarts = 0
      if (restarts >= MAX_RESTARTS) {
        fail(lastError === 'no-speech'
          ? '음성이 감지되지 않은 채 인식이 짧게 반복 종료되었습니다. 입력 장치를 확인하고 마이크를 다시 켜거나 텍스트로 입력해 주세요. 사용자 차례는 유지됩니다.'
          : '음성 인식이 결과 없이 짧게 반복 종료되어 자동 재연결을 멈췄습니다. 브라우저가 종료 원인을 제공하지 않았습니다. 마이크·사이트 권한·네트워크를 확인한 뒤 다시 켜주세요. 사용자 차례는 유지됩니다.',
        lastError === 'no-speech' ? 'no-speech' : 'repeated-end')
        return
      }
      if (!healthy) restarts++
      trace('restart', healthy ? 'healthy-session' : lastError ?? 'short-disconnection')
      emit({ phase: 'restarting', message: healthy
        ? '인식이 잠시 종료되어 다시 연결합니다. 사용자 차례와 확정된 문장은 유지됩니다.'
        : '인식 연결을 다시 시도합니다 (' + restarts + '/' + MAX_RESTARTS + ').' })
      timer = setTimeout(open, RESTART_DELAY_MS)
    }
    emit({ phase: 'starting', errorCode: undefined, interimText: '', message: '마이크 권한을 확인하고 음성 인식을 시작합니다.' })
    if (!valid()) return
    timer = setTimeout(() => fail('마이크가 시작되지 않았습니다. 권한 요청과 장치 연결을 확인하거나 텍스트로 입력해 주세요.'), START_TIMEOUT_MS)
    try { trace('start-request'); recognition.start() } catch (error) {
      const name = error instanceof Error ? error.name : ''
      const code = ['NotAllowedError', 'SecurityError'].includes(name) ? 'not-allowed'
        : ['NotFoundError', 'NotReadableError'].includes(name) ? 'audio-capture'
        : name === 'InvalidStateError' ? 'start-conflict' : 'start-failed'
      trace('error', code)
      fail(speechErrorMessage(code), code)
    }
  }
  return {
    start() {
      if (disposed || snapshot.phase !== 'idle') return
      if (!factory) { fail('이 브라우저는 음성 인식을 지원하지 않습니다. Chrome을 사용하거나 텍스트로 입력해 주세요.'); return }
      open()
    },
    stop,
    cancel() {
      if (disposed) return
      clearTimer()
      stopIntent = null
      trace('cancel')
      detach(true)
      emit({ phase: 'review', message: '마이크를 중단했습니다. 확정된 문장은 입력창에서 확인할 수 있습니다.' })
    },
    dispose() {
      disposed = true
      clearTimer()
      stopIntent = null
      detach(true)
    },
    getSnapshot: () => snapshot,
  }
}
