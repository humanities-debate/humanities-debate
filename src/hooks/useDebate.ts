import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { debateReducer, elapsedSeconds, initialState, isActive } from '../logic/debate'
import type { DebateAction } from '../logic/debate'
import { scheduleTurn } from '../logic/turnScheduler'
import { mockAIProvider } from '../providers/MockAIProvider'
import { localAIProvider } from '../providers/LocalAIProvider'
import { useSpeechRecognition } from './useSpeechRecognition'
import { useAIModels } from './useAIModels'

export function useDebate() {
  const [state, reactDispatch] = useReducer(debateReducer, { ...initialState, engine: 'real' as const })
  // Events can arrive in the same React batch. Decisions must see preceding events,
  // including voice results, rather than the last painted render.
  const latest = useRef(state)
  const dispatch = useCallback((action: DebateAction) => {
    latest.current = debateReducer(latest.current, action)
    reactDispatch(action)
  }, [])
  const speech = useSpeechRecognition(dispatch)
  const models = useAIModels(dispatch)
  const [now, setNow] = useState(0)
  const cancelTurn = useRef<() => void>(() => {})
  const running = isActive(state.status)
  const { status, generationId, pending, waitUntil, engine } = state

  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [running])

  useEffect(() => {
    if (latest.current.generationId !== generationId || latest.current.status !== status) return
    const cancel = scheduleTurn({ status, generationId, pending, waitUntil }, dispatch, engine === 'real' ? localAIProvider : mockAIProvider)
    cancelTurn.current = cancel
    return cancel
  }, [status, generationId, pending, waitUntil, engine, dispatch])

  function send(action: DebateAction) {
    // Cancel immediately on a valid transition, before React runs effect cleanup.
    // Invalid repeat clicks must not cancel the current, valid AI request.
    const current = latest.current
    if (debateReducer(current, action).generationId !== current.generationId) {
      cancelTurn.current()
      speech.cancel(action.type === 'PAUSE' || action.type === 'RESUME')
    }
    if (action.type === 'START' || action.type === 'RESUME') setNow(action.timestamp)
    dispatch(action)
  }

  function startSpeaking(mode: 'voice' | 'text') {
    const action: DebateAction = { type: 'USER_START', timestamp: Date.now() }
    const current = latest.current
    const next = debateReducer(current, action)
    if (next === current) return
    send(action)
    if (mode === 'voice') speech.start(next.generationId, '')
  }
  function restartMicrophone() {
    const current = latest.current
    if (current.status === 'userSpeaking') speech.start(current.generationId, current.draft)
  }
  return { state, send, running, elapsed: elapsedSeconds(state, now), now, speech, startSpeaking, restartMicrophone, models }
}
