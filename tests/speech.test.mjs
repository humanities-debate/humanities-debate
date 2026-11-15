import assert from 'node:assert/strict'
import test from 'node:test'
import { createSpeechSession, HEALTHY_LISTEN_MS, MAX_DIAGNOSTICS, MAX_RESTARTS, RESTART_DELAY_MS, STOP_TIMEOUT_MS, START_TIMEOUT_MS } from '../src/speech/session.ts'
import { debateReducer, initialState, MAX_INPUT_LENGTH } from '../src/logic/debate.ts'
import { decisionTopic } from '../src/data/topics.ts'
import { emptySpeech, speechStatus } from '../src/speech/types.ts'

class FakeRecognition {
  lang = ''
  continuous = false
  interimResults = false
  onstart = null
  onresult = null
  onerror = null
  onend = null
  starts = 0
  stops = 0
  aborts = 0
  start() { this.starts++; this.onstart?.() }
  stop() { this.stops++ }
  abort() { this.aborts++; this.onend?.() }
  result(parts, resultIndex = 0) {
    this.onresult?.({ resultIndex, results: parts.map(([text, isFinal]) => ({ 0: { transcript: text }, isFinal })) })
  }
  end() { this.onend?.() }
  error(error) { this.onerror?.({ error }) }
}
function setup(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const instances = []
  const changes = []
  const submissions = []
  let state = debateReducer(initialState, { type: 'START', topic: decisionTopic, timestamp: Date.now() })
  state = debateReducer(state, { type: 'USER_START', timestamp: Date.now() })
  const generationId = state.generationId
  const factory = options.unsupported ? null : () => {
    const instance = options.create ? options.create() : new FakeRecognition()
    instances.push(instance)
    return instance
  }
  const controller = createSpeechSession(factory, snapshot => {
    changes.push(snapshot)
    state = debateReducer(state, { type: 'VOICE_DRAFT', generationId, text: snapshot.finalText })
  }, text => {
    submissions.push(text)
    state = debateReducer(state, { type: 'VOICE_FINISH', generationId, text, timestamp: Date.now() })
  }, options.seed ?? '')
  t.after(() => controller.dispose())
  return {
    controller, instances, changes, submissions,
    get state() { return state },
    get snapshot() { return controller.getSnapshot() },
    send(action) { state = debateReducer(state, { topic: decisionTopic, generationId: state.generationId, timestamp: Date.now(), ...action }) },
    tick(ms) { t.mock.timers.tick(ms) },
  }
}
test('Korean continuous recognition separates interim/final and replaces repeated result indices', t => {
  const h = setup(t)
  h.controller.start()
  const r = h.instances[0]
  assert.equal(r.lang, 'ko-KR')
  assert.equal(r.continuous, true)
  assert.equal(r.interimResults, true)
  r.result([['저는', false]])
  assert.equal(h.state.draft, '')
  assert.equal(h.snapshot.interimText, '저는')
  r.result([['저는 동의합니다.', true], ['근거는', false]])
  r.result([['저는 동의합니다.', true], ['근거는 데이터입니다.', false]], 1)
  r.result([['저는 동의합니다.', true], ['근거는 데이터입니다.', true]], 1)
  r.result([['저는 동의합니다.', true], ['근거는 데이터입니다.', true]], 1)
  assert.equal(h.state.draft, '저는 동의합니다. 근거는 데이터입니다.')
  assert.equal(h.snapshot.interimText, '')
  assert.equal(h.state.history.length, 0)
})
test('stop waits for late final result and onend, then saves once and immediately prepares AI', t => {
  const h = setup(t)
  h.send({ type: 'WAIT_SETTING', seconds: 40 })
  h.controller.start()
  const r = h.instances[0]
  r.result([['첫 문장.', true], ['마지막', false]])
  h.controller.stop('submit')
  h.controller.stop('submit')
  assert.equal(r.stops, 1)
  assert.equal(h.state.status, 'userSpeaking')
  assert.equal(h.state.history.length, 0)
  r.result([['첫 문장.', true], ['마지막 문장.', true]], 1)
  const lateResult = r.onresult
  const lateEnd = r.onend
  r.end()
  lateEnd()
  lateResult({ resultIndex: 0, results: [{ 0: { transcript: '늦은 문장' }, isFinal: true }] })
  assert.equal(h.state.history.length, 1)
  assert.equal(h.state.history[0].text, '첫 문장. 마지막 문장.')
  assert.equal(h.state.history[0].source, 'speech')
  assert.equal(h.state.status, 'aiTyping')
  assert.equal(h.state.waitUntil, null)
  assert.equal(h.state.pending.history.at(-1).text, '첫 문장. 마지막 문장.')
  assert.equal(h.submissions.length, 1)
})
test('stop for review allows correction before submission and does not restart or auto-save', t => {
  const h = setup(t)
  h.controller.start()
  h.instances[0].result([['원문', true]])
  h.controller.stop('review')
  h.instances[0].end()
  assert.equal(h.snapshot.phase, 'review')
  assert.equal(h.state.history.length, 0)
  h.send({ type: 'DRAFT', text: '수정한 문장' })
  h.controller.dispose()
  h.send({ type: 'USER_FINISH' })
  assert.equal(h.state.history[0].text, '수정한 문장')
  h.tick(60000)
  assert.equal(h.instances.length, 1)
})
test('productive recognition can reconnect repeatedly without exhausting a lifetime restart budget', t => {
  const h = setup(t)
  h.controller.start()
  for (let i = 0; i < MAX_RESTARTS + 4; i++) {
    h.instances[i].result([['하지만 제 경험상', true]])
    h.instances[i].end()
    assert.equal(h.state.status, 'userSpeaking')
    h.tick(RESTART_DELAY_MS)
  }
  assert.equal(h.instances.length, MAX_RESTARTS + 5)
  assert.equal(h.snapshot.phase, 'listening')
  assert.equal(h.snapshot.finalText, Array(MAX_RESTARTS + 4).fill('하지만 제 경험상').join(' '))
  assert.equal(h.submissions.length, 0)
  assert.equal(h.state.status, 'userSpeaking')
})

test('rapid empty start/end loops still stop after the original two retries, with an honest unknown cause', t => {
  const h = setup(t)
  h.controller.start()
  for (let i = 0; i <= MAX_RESTARTS; i++) {
    h.instances[i].end()
    h.tick(RESTART_DELAY_MS)
  }
  h.tick(60000)
  assert.equal(h.instances.length, MAX_RESTARTS + 1)
  assert.equal(h.snapshot.phase, 'error')
  assert.equal(h.snapshot.errorCode, 'repeated-end')
  assert.match(h.snapshot.message, /종료 원인을 제공하지 않았습니다/)
  assert.equal(h.state.status, 'userSpeaking')
  assert.equal(h.submissions.length, 0)
})

test('a sustained silent session can reconnect repeatedly but never submits or advances AI', t => {
  const h = setup(t)
  h.controller.start()
  for (let i = 0; i < 5; i++) {
    h.tick(HEALTHY_LISTEN_MS)
    h.instances[i].error('no-speech')
    h.instances[i].end()
    h.tick(RESTART_DELAY_MS)
  }
  assert.equal(h.instances.length, 6)
  assert.equal(h.snapshot.phase, 'listening')
  assert.equal(h.state.status, 'userSpeaking')
  assert.equal(h.submissions.length, 0)
})

test('no-speech in a rapid termination loop keeps its own cause, not a permission or network diagnosis', t => {
  const h = setup(t)
  h.controller.start()
  for (let i = 0; i <= MAX_RESTARTS; i++) {
    h.instances[i].error('no-speech')
    h.instances[i].end()
    h.tick(RESTART_DELAY_MS)
  }
  assert.equal(h.snapshot.errorCode, 'no-speech')
  assert.match(h.snapshot.message, /음성이 감지되지 않은 채/)
  assert.equal(h.state.history.length, 0)
})

test('a successful final result resets consecutive failures without deleting any genuine repetition', t => {
  const h = setup(t)
  h.controller.start()
  for (let round = 0; round < 3; round++) {
    h.instances.at(-1).end(); h.tick(RESTART_DELAY_MS)
    h.instances.at(-1).end(); h.tick(RESTART_DELAY_MS)
    h.instances.at(-1).result([['끝이라고 말했습니다. 끝이라고 말했습니다.', true]])
    h.instances.at(-1).end(); h.tick(RESTART_DELAY_MS)
  }
  assert.equal(h.snapshot.phase, 'listening')
  assert.equal(h.snapshot.finalText, Array(3).fill('끝이라고 말했습니다. 끝이라고 말했습니다.').join(' '))
  assert.equal(h.submissions.length, 0)
})

test('a browser abort after explicit stop waits for end and requires review instead of auto-save/restart', t => {
  const h = setup(t)
  h.controller.start()
  const r = h.instances[0]
  r.result([['확정한 원문', true], ['마지막 단어', false]])
  h.controller.stop('submit')
  r.error('aborted')
  assert.equal(h.snapshot.phase, 'stopping')
  r.result([['확정한 원문', true], ['마지막 단어', true]])
  r.end()
  h.tick(60000)
  assert.equal(h.snapshot.phase, 'review')
  assert.equal(h.snapshot.finalText, '확정한 원문 마지막 단어')
  assert.equal(h.instances.length, 1)
  assert.equal(h.submissions.length, 0)
  h.send({ type: 'USER_FINISH' }); h.send({ type: 'USER_FINISH' })
  assert.equal(h.state.history.length, 1)
  assert.equal(h.state.history[0].text, '확정한 원문 마지막 단어')
})

test('an aborted stop without end remains bounded by the original stop watchdog', t => {
  const h = setup(t)
  h.controller.start(); h.controller.stop('submit')
  h.instances[0].error('aborted')
  h.tick(STOP_TIMEOUT_MS)
  assert.equal(h.snapshot.phase, 'error')
  assert.equal(h.instances[0].aborts, 1)
  assert.equal(h.submissions.length, 0)
})

test('explicit cancellation detaches abort/end events and stops a queued restart', t => {
  const h = setup(t)
  h.controller.start()
  const r = h.instances[0], lateEnd = r.onend, lateError = r.onerror
  r.result([['남길 원문', true]])
  r.end(); h.controller.cancel()
  lateError({ error: 'aborted' }); lateEnd()
  h.tick(60000)
  assert.equal(h.snapshot.phase, 'review')
  assert.equal(h.snapshot.finalText, '남길 원문')
  assert.equal(h.instances.length, 1)
  assert.equal(h.submissions.length, 0)
})

test('diagnostics are bounded and contain only event metadata, with no transcript or vendor message', t => {
  const h = setup(t)
  h.controller.start()
  for (let i = 0; i < 8; i++) {
    h.instances.at(-1).onaudiostart()
    h.instances.at(-1).result([['발언에만 있어야 할 원문', true]])
    h.instances.at(-1).end(); h.tick(RESTART_DELAY_MS)
  }
  h.instances.at(-1).onerror({ error: 'secret-vendor-text', message: 'sensitive-message' })
  const diagnostic = JSON.stringify(h.snapshot.diagnostics)
  assert.equal(h.snapshot.diagnostics.length, MAX_DIAGNOSTICS)
  for (const entry of h.snapshot.diagnostics) {
    assert.ok(Object.keys(entry).every(key => ['event', 'attempt', 'elapsedMs', 'code'].includes(key)))
    assert.ok(Number.isFinite(entry.elapsedMs) && entry.elapsedMs >= 0)
  }
  for (const text of ['발언에만 있어야 할 원문', 'secret-vendor-text', 'sensitive-message']) assert.equal(diagnostic.includes(text), false)
  assert.equal(h.snapshot.errorCode, 'recognition-error')
  assert.ok(h.snapshot.diagnostics.some(entry => entry.event === 'audio-start'))
})

for (const [name, expected] of [['InvalidStateError', 'start-conflict'], ['NotFoundError', 'audio-capture'], ['SecurityError', 'not-allowed']]) {
  test('synchronous ' + name + ' is classified without an automatic retry loop', t => {
    const h = setup(t, { create: () => {
      const r = new FakeRecognition()
      r.start = () => { const e = new Error('private browser message'); e.name = name; throw e }
      return r
    } })
    h.controller.start(); h.tick(60000)
    assert.equal(h.snapshot.errorCode, expected)
    assert.equal(h.instances.length, 1)
    assert.equal(h.snapshot.message.includes('private browser message'), false)
  })
}
test('user stop during restart gap prevents further microphone starts', t => {
  const h = setup(t)
  h.controller.start()
  h.instances[0].result([['의견입니다', true]])
  h.instances[0].end()
  h.controller.stop('submit')
  h.tick(60000)
  assert.equal(h.instances.length, 1)
  assert.equal(h.submissions.length, 1)
})
for (const error of ['not-allowed', 'audio-capture', 'network', 'service-not-allowed', 'aborted']) {
  test('error ' + error + ' preserves confirmed text and leaves user in text-editable turn', t => {
    const h = setup(t)
    h.controller.start()
    h.instances[0].result([['보존할 의견', true]])
    const lateEnd = h.instances[0].onend
    h.instances[0].error(error)
    lateEnd()
    h.tick(60000)
    assert.equal(h.snapshot.phase, 'error')
    assert.equal(h.snapshot.errorCode, error)
    assert.ok(h.snapshot.diagnostics.some(entry => entry.event === 'error' && entry.code === error))
    assert.ok(h.snapshot.message)
    assert.equal(h.state.draft, '보존할 의견')
    assert.equal(h.state.status, 'userSpeaking')
    assert.equal(h.instances.length, 1)
    h.send({ type: 'DRAFT', text: '텍스트로 보완한 의견' })
    h.controller.dispose()
    h.send({ type: 'USER_FINISH' })
    assert.equal(h.state.history[0].text, '텍스트로 보완한 의견')
  })
}
test('unsupported browser falls back without losing the user turn', t => {
  const h = setup(t, { unsupported: true })
  h.controller.start()
  assert.equal(h.snapshot.phase, 'error')
  assert.match(h.snapshot.message, /지원하지/)
  assert.equal(h.state.status, 'userSpeaking')
  assert.equal(h.instances.length, 0)
})
test('empty speech is never recorded and no-speech does not submit automatically', t => {
  const h = setup(t)
  h.controller.start()
  h.instances[0].error('no-speech')
  h.instances[0].end()
  h.tick(RESTART_DELAY_MS)
  assert.equal(h.state.status, 'userSpeaking')
  h.controller.stop('submit')
  h.instances[1].error('no-speech')
  h.instances[1].end()
  assert.equal(h.state.history.length, 0)
  assert.equal(h.state.status, 'aiShowing')
})
test('stop watchdog aborts microphone and preserves final data without auto-submit', t => {
  const h = setup(t)
  h.controller.start()
  h.instances[0].result([['확정된 내용', true]])
  h.controller.stop('submit')
  h.tick(STOP_TIMEOUT_MS)
  assert.equal(h.snapshot.phase, 'error')
  assert.equal(h.instances[0].aborts, 1)
  assert.equal(h.state.draft, '확정된 내용')
  assert.equal(h.state.history.length, 0)
})
test('missing start and thrown start are bounded and offer fallback', t => {
  const h = setup(t, { create: () => {
    const r = new FakeRecognition()
    r.start = () => { r.starts++ }
    return r
  } })
  h.controller.start()
  h.tick(START_TIMEOUT_MS)
  assert.equal(h.snapshot.phase, 'error')
  assert.equal(h.instances[0].aborts, 1)
})
test('unconfirmed interim after end is not silently saved as final', t => {
  const h = setup(t)
  h.controller.start()
  h.instances[0].result([['확정', true], ['임시 내용', false]])
  h.controller.stop('submit')
  h.instances[0].end()
  assert.equal(h.submissions.length, 0)
  assert.equal(h.state.draft, '확정')
  assert.equal(h.snapshot.interimText, '임시 내용')
  assert.match(h.snapshot.message, /확정되지/)
})
test('dispose/ending debate invalidates callbacks even if the browser ignores abort', t => {
  const h = setup(t)
  h.controller.start()
  const r = h.instances[0]
  const result = r.onresult
  const end = r.onend
  const error = r.onerror
  h.controller.dispose()
  const count = h.changes.length
  h.send({ type: 'END' })
  h.send({ type: 'START' })
  h.send({ type: 'USER_START' })
  result({ resultIndex: 0, results: [{ 0: { transcript: '오래된 발언' }, isFinal: true }] })
  end()
  error({ error: 'network' })
  h.tick(60000)
  assert.equal(h.changes.length, count)
  assert.equal(h.state.draft, '')
  assert.equal(h.submissions.length, 0)
  assert.equal(r.aborts, 1)
})
test('reducer rejects stale voice drafts and completion after pause or a newer turn', t => {
  const h = setup(t)
  const old = h.state.generationId
  h.send({ type: 'PAUSE' })
  h.send({ type: 'RESUME' })
  h.send({ type: 'VOICE_DRAFT', text: '오래된 내용', generationId: old })
  h.send({ type: 'VOICE_FINISH', text: '오래된 내용', generationId: old })
  assert.equal(h.state.draft, '')
  assert.equal(h.state.history.length, 0)
})
test('rapid starts do not create duplicate instances, seeded edits are preserved', t => {
  const h = setup(t, { seed: '수정한 초안' })
  for (let i = 0; i < 10; i++) h.controller.start()
  assert.equal(h.instances.length, 1)
  h.instances[0].result([['추가 문장', true]])
  assert.equal(h.state.draft, '수정한 초안 추가 문장')
  h.controller.stop('submit')
  h.instances[0].end()
  assert.equal(h.state.history.length, 1)
})

test('stop before onstart accepts the last result once and never restarts', t => {
  const h = setup(t, { create: () => {
    const r = new FakeRecognition()
    r.start = () => { r.starts++ }
    return r
  } })
  h.controller.start()
  const r = h.instances[0]
  for (let i = 0; i < 10; i++) { h.controller.start(); h.controller.stop('submit') }
  r.onstart()
  assert.equal(h.snapshot.phase, 'stopping')
  r.result([['마지막 결과', true]])
  r.end()
  h.tick(60000)
  assert.equal(r.starts, 1)
  assert.equal(r.stops, 1)
  assert.deepEqual(h.submissions, ['마지막 결과'])
  assert.equal(h.instances.length, 1)
})

test('old instance callbacks cannot add duplicate results after an automatic restart', t => {
  const h = setup(t)
  h.controller.start()
  const first = h.instances[0]
  first.result([['첫 문장', true]])
  const lateResult = first.onresult, lateStart = first.onstart, lateEnd = first.onend
  first.end(); h.tick(RESTART_DELAY_MS)
  const second = h.instances[1]
  lateStart(); lateResult({ resultIndex: 0, results: [{ 0: { transcript: '첫 문장' }, isFinal: true }] }); lateEnd()
  second.result([['새 문장', true]])
  second.result([['새 문장', true]])
  assert.equal(h.snapshot.finalText, '첫 문장 새 문장')
  assert.equal(h.instances.length, 2)
  assert.equal(h.submissions.length, 0)
})

test('speech arriving after no-speech cancels its watchdog, but not the explicit stop watchdog', t => {
  const h = setup(t)
  h.controller.start()
  const r = h.instances[0]
  r.error('no-speech')
  r.result([['다시 들리는 문장', true]])
  h.tick(STOP_TIMEOUT_MS + 1)
  assert.equal(h.snapshot.phase, 'listening')
  h.controller.stop('submit')
  r.result([['다시 들리는 문장', true], ['추가 내용', true]])
  h.tick(STOP_TIMEOUT_MS)
  assert.equal(h.snapshot.phase, 'error')
  assert.equal(h.snapshot.finalText, '다시 들리는 문장 추가 내용')
  assert.equal(h.submissions.length, 0)
})

test('manual edits including line breaks survive microphone start and an error unchanged', t => {
  const seed = '직접 입력한 내용\n  두 번째 줄\n'
  const h = setup(t, { seed })
  h.controller.start()
  h.instances[0].result([['인식 중', false]])
  assert.equal(h.snapshot.finalText, seed)
  h.instances[0].error('network')
  assert.equal(h.snapshot.finalText, seed)
  assert.equal(h.snapshot.errorCode, 'network')
})

test('cancel preserves unconfirmed text separately and recovery never silently submits', t => {
  const h = setup(t)
  h.controller.start()
  h.instances[0].result([['확정된 부분', true], ['확인할 임시 문장', false]])
  h.controller.cancel()
  assert.equal(h.snapshot.interimText, '확인할 임시 문장')
  assert.equal(h.snapshot.finalText, '확정된 부분')
  h.controller.dispose()
  const r = new FakeRecognition()
  let current, submitted = 0
  const next = createSpeechSession(() => r, s => { current = s }, () => submitted++, h.snapshot.finalText,
    { recoveryText: h.snapshot.interimText })
  t.after(() => next.dispose())
  next.start(); r.result([['새 문장', true]]); next.stop('submit'); r.end()
  assert.equal(current.finalText, '확정된 부분 새 문장')
  assert.equal(current.recoveryText, '확인할 임시 문장')
  assert.equal(current.phase, 'review')
  assert.equal(submitted, 0)
})

test('input overflow remains visible for copying and is never automatically recorded', t => {
  const h = setup(t)
  h.controller.start()
  h.instances[0].result([['가'.repeat(MAX_INPUT_LENGTH) + '보존할 초과분', true]])
  h.instances[0].end()
  assert.equal(h.snapshot.overflowText, '보존할 초과분')
  assert.equal(h.snapshot.finalText.length, MAX_INPUT_LENGTH)
  assert.equal(h.submissions.length, 0)
})

test('microphone labels distinguish availability, stopping, permission denial and errors', () => {
  assert.equal(speechStatus(emptySpeech), '말하기 가능')
  assert.match(speechStatus({ ...emptySpeech, phase: 'listening' }), /인식 중/)
  assert.match(speechStatus({ ...emptySpeech, phase: 'stopping' }), /종료 처리/)
  assert.match(speechStatus({ ...emptySpeech, phase: 'error', errorCode: 'not-allowed' }), /권한 없음/)
  assert.match(speechStatus({ ...emptySpeech, phase: 'error', errorCode: 'network' }), /인식 오류/)
})
test('input length limit stops recognition for review instead of silent auto-save', t => {
  const h = setup(t)
  h.controller.start()
  h.instances[0].result([['가'.repeat(MAX_INPUT_LENGTH + 50), true]])
  assert.equal(h.instances[0].stops, 1)
  h.instances[0].end()
  assert.equal(h.state.draft.length, MAX_INPUT_LENGTH)
  assert.equal(h.state.history.length, 0)
})
test('synchronous recognition start failure gives a permission error and never restarts', t => {
  const h = setup(t, { create: () => {
    const r = new FakeRecognition()
    r.start = () => { const error = new Error('denied'); error.name = 'NotAllowedError'; throw error }
    return r
  } })
  h.controller.start()
  h.tick(60000)
  assert.equal(h.snapshot.phase, 'error')
  assert.match(h.snapshot.message, /권한/)
  assert.equal(h.instances.length, 1)
  assert.equal(h.state.status, 'userSpeaking')
})

test('voice session integrates with AI scheduler: interrupts typing, waits during speech, resumes after final onend', async t => {
  const { scheduleTurn } = await import('../src/logic/turnScheduler.ts')
  const { mockAIProvider } = await import('../src/providers/MockAIProvider.ts')
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  let state = initialState
  let cancel = () => {}
  const dispatch = action => {
    const previous = state
    state = debateReducer(state, action)
    if (previous.status !== state.status || previous.generationId !== state.generationId ||
        previous.pending !== state.pending || previous.waitUntil !== state.waitUntil) {
      cancel()
      cancel = scheduleTurn(state, dispatch, mockAIProvider)
    }
  }
  const act = (type, extras = {}) => dispatch({ type, topic: decisionTopic, timestamp: Date.now(), generationId: state.generationId, ...extras })
  const tick = async ms => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
    t.mock.timers.tick(ms)
    for (let i = 0; i < 12; i++) await Promise.resolve()
  }
  act('START')
  await tick(4000)
  const staleAI = state.generationId
  act('USER_START')
  const voiceGeneration = state.generationId
  const recognition = new FakeRecognition()
  const controller = createSpeechSession(() => recognition,
    snapshot => dispatch({ type: 'VOICE_DRAFT', generationId: voiceGeneration, text: snapshot.finalText }),
    text => dispatch({ type: 'VOICE_FINISH', generationId: voiceGeneration, text, timestamp: Date.now() }))
  t.after(() => { controller.dispose(); cancel() })
  controller.start()
  recognition.result([['사용자 의견', false]])
  await tick(60000)
  assert.equal(state.status, 'userSpeaking')
  assert.equal(state.history.length, 0)
  act('AI_READY', { generationId: staleAI, text: '취소된 응답' })
  assert.equal(state.history.length, 0)
  controller.stop('submit')
  recognition.result([['사용자 의견입니다.', true]])
  assert.equal(state.history.length, 0)
  recognition.end()
  assert.equal(state.history.length, 1)
  assert.equal(state.history[0].text, '사용자 의견입니다.')
  assert.equal(state.status, 'aiTyping')
  assert.equal(state.waitUntil, null)
  await tick(4999)
  assert.equal(state.history.length, 1)
  await tick(1)
  assert.equal(state.history.length, 2)
  assert.equal(state.waitUntil, Date.now() + 10000)
  assert.match(state.history[1].text, /사용자 의견입니다/)
  assert.equal(state.history[1].replyToId, state.history[0].id)
})
