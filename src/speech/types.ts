export type RecognitionResult = { isFinal: boolean; readonly [index: number]: { transcript: string } }
export type RecognitionEvent = { resultIndex: number; results: ArrayLike<RecognitionResult> }
export interface Recognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  onstart: (() => void) | null
  onresult: ((event: RecognitionEvent) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  onaudiostart?: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}
export type RecognitionFactory = () => Recognition
export function browserRecognitionFactory(): RecognitionFactory | null {
  if (typeof window === 'undefined') return null
  const host = window as unknown as {
    SpeechRecognition?: new () => Recognition
    webkitSpeechRecognition?: new () => Recognition
  }
  const Constructor = host.SpeechRecognition ?? host.webkitSpeechRecognition
  return Constructor ? () => new Constructor() : null
}
export type SpeechPhase = 'idle' | 'starting' | 'listening' | 'restarting' | 'stopping' | 'review' | 'error'
export type SpeechDiagnostic = {
  event: 'start-request' | 'start' | 'audio-start' | 'interim-result' | 'final-result' | 'error' | 'end' | 'restart' | 'stop-request' | 'cancel'
  attempt: number
  elapsedMs: number
  code?: string
}
export type SpeechSnapshot = { phase: SpeechPhase; finalText: string; interimText: string; message: string; errorCode?: string; recoveryText?: string; overflowText?: string; diagnostics?: SpeechDiagnostic[] }
export const emptySpeech: SpeechSnapshot = { phase: 'idle', finalText: '', interimText: '', message: '' }
export function speechBusy(phase: SpeechPhase) {
  return phase === 'starting' || phase === 'listening' || phase === 'restarting' || phase === 'stopping'
}

export function speechStatus(snapshot: SpeechSnapshot) {
  if (snapshot.phase === 'error') {
    if (snapshot.errorCode === 'not-allowed') return '마이크 권한 없음 · 텍스트 입력 가능'
    if (snapshot.errorCode === 'audio-capture') return '마이크 연결 확인 · 텍스트 입력 가능'
    if (snapshot.errorCode === 'network') return '인식 오류 · 서비스 연결 확인 · 텍스트 입력 가능'
    if (snapshot.errorCode === 'service-not-allowed') return '인식 서비스 제한 · 텍스트 입력 가능'
    return '인식 오류 · 텍스트 입력 가능'
  }
  return { idle: '말하기 가능', starting: '마이크 연결 중', listening: '마이크 인식 중',
    restarting: '인식 다시 연결 중', stopping: '발언 종료 처리 중 · 마지막 결과 확인', review: '발언 확인·수정 중' }[snapshot.phase]
}
