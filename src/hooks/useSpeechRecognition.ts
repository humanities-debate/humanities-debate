import { useEffect, useRef, useState } from 'react'
import type { DebateAction } from '../logic/debate'
import { createSpeechSession } from '../speech/session'
import { browserRecognitionFactory, emptySpeech, speechBusy } from '../speech/types'
import { createLocalSpeechSession } from '../speech/localSession'
import { createPCMCapture } from '../speech/pcmCapture'

export function useSpeechRecognition(dispatch: (action: DebateAction) => void) {
  const [snapshot, setSnapshot] = useState(emptySpeech)
  const [supported] = useState(() => Boolean(window.debateDesktop || browserRecognitionFactory()))
  const session = useRef<ReturnType<typeof createSpeechSession> | ReturnType<typeof createLocalSpeechSession> | null>(null)
  useEffect(() => () => { session.current?.dispose(); session.current = null }, [])

  function start(generationId: number, seed: string) {
    if (session.current && speechBusy(session.current.getSnapshot().phase)) return
    const previous = session.current?.getSnapshot()
    session.current?.dispose()
    let previousFinal = seed
    const changed = (next: typeof emptySpeech) => {
      setSnapshot(next)
      if (next.finalText !== previousFinal) {
        previousFinal = next.finalText
        dispatch({ type: 'VOICE_DRAFT', generationId, text: next.finalText })
      }
    }
    const recovered = { recoveryText: [previous?.recoveryText, previous?.interimText].filter(Boolean).join('\n'), overflowText: previous?.overflowText }
    const desktop = window.debateDesktop
    session.current = desktop ? createLocalSpeechSession({ capture: createPCMCapture, transcribe: desktop.transcribe, cancel: desktop.cancelSpeech }, changed, seed, recovered)
      : createSpeechSession(browserRecognitionFactory(), changed, (text) => {
      dispatch({ type: 'VOICE_FINISH', generationId, text, timestamp: Date.now() })
    }, seed, recovered)
    session.current.start()
  }
  function cancel(preserve = false) {
    if (preserve) session.current?.cancel()
    session.current?.dispose()
    if (preserve && session.current) {
      setSnapshot(previous => ({ ...previous, phase: 'review', message: window.debateDesktop
        ? '마이크를 멈췄습니다. 아직 변환하지 않은 음성은 취소됐으며 기존 글은 유지됩니다. 재개 후 다시 말하거나 입력해 주세요.'
        : '마이크를 멈췄습니다. 재개 후 내용을 확인하거나 마이크를 다시 켜주세요.' }))
    } else {
      session.current = null
      setSnapshot(emptySpeech)
    }
  }
  return {
    snapshot, supported, busy: speechBusy(snapshot.phase), start, cancel,
    stop: (intent: 'submit' | 'review') => session.current?.stop(intent),
  }
}
