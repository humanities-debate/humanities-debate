import assert from 'node:assert/strict'
import test from 'node:test'
import { debateReducer, initialState, participantView } from '../src/logic/debate.ts'
import { scheduleTurn } from '../src/logic/turnScheduler.ts'
import { decisionTopic, practiceTopics } from '../src/data/topics.ts'
import { completedRecord, parseRecord, userMessages, participantMessages, evidenceMessage, recordText } from '../src/records/record.ts'
import { createLocalRecordRepository, RECORD_KEY_PREFIX } from '../src/records/repository.ts'
import { createRecordLibrary } from '../src/records/library.ts'

const act = (state, type, extra = {}) => debateReducer(state, { type, generationId: state.generationId, timestamp: 10000, ...extra })
function ended(mode = 'normal') {
  let state = act(initialState, 'MODE', { mode })
  state = act(state, 'START', { topic: decisionTopic, timestamp: 1000 })
  state = act(state, 'AI_READY', { text: 'AI의 첫 근거입니다.', timestamp: 6000 })
  state = act(state, 'USER_START', { timestamp: 7000 })
  const generation = state.generationId
  state = act(state, 'VOICE_DRAFT', { text: '인식 중인 초안' })
  state = act(state, 'VOICE_FINISH', { text: '최종 의견입니다.\n추가 근거입니다.', timestamp: 8000 })
  state = act(state, 'VOICE_FINISH', { generationId: generation, text: '늦은 중복 결과', timestamp: 8100 })
  state = act(state, 'AI_READY', { text: '사용자 의견에 대한 답변입니다.', timestamp: 13000 })
  return act(state, 'END', { timestamp: 14000 })
}
function memoryStorage() {
  const data = new Map()
  let failSave = false, failRead = false, failRemove = false, writes = 0
  const storage = {
    get length() { if (failRead) throw new Error('read denied'); return data.size },
    key: index => [...data.keys()][index] ?? null,
    getItem(key) { if (failRead) throw new Error('read denied'); return data.get(key) ?? null },
    setItem(key, value) { if (failSave) throw new Error('quota'); writes++; data.set(key, value) },
    removeItem(key) { if (failRemove) throw new Error('delete denied'); data.delete(key) },
  }
  return { data, storage, get writes() { return writes },
    failSave(value) { failSave = value }, failRead(value) { failRead = value }, failRemove(value) { failRemove = value } }
}

test('only committed messages retain original IDs, order, names and text across blind modes', () => {
  const normal = completedRecord(ended(), 'record-normal')
  const state = ended('practice')
  assert.equal(participantView(state, 'ai1').hidden, true)
  const blind = completedRecord(state, 'record-blind')
  assert.deepEqual(blind.messages, normal.messages)
  assert.deepEqual(blind.messages.map(m => m.order), [1, 2, 3])
  assert.deepEqual(blind.messages.map(m => m.speakerName), ['김지훈', '나', '이서연'])
  assert.deepEqual(blind.messages.map(m => m.id), state.history.map(m => m.id))
  assert.deepEqual(blind.messages.map(m => m.text), state.history.map(m => m.text))
  assert.equal(userMessages(blind).length, 1)
  assert.equal(participantMessages(blind, 'ai2').length, 1)
  assert.equal(evidenceMessage(blind, 'msg-2').text, '최종 의견입니다.\n추가 근거입니다.')
  assert.ok(recordText(blind).includes('최종 의견입니다.\n추가 근거입니다.'))
  assert.deepEqual(blind.topic.context, decisionTopic.context)
})

test('ending speech never promotes a draft; late AI or speech results cannot change the completed record', () => {
  let state = act(initialState, 'START', { topic: decisionTopic, timestamp: 1000 })
  const oldAI = state.generationId
  state = act(state, 'USER_START')
  state = act(state, 'VOICE_DRAFT', { text: '아직 제출하지 않은 문장' })
  const oldVoice = state.generationId
  state = act(state, 'END')
  const record = completedRecord(state, 'empty-record')
  for (const action of [
    { type: 'AI_READY', generationId: oldAI, text: '취소된 AI' },
    { type: 'VOICE_FINISH', generationId: oldVoice, text: '뒤늦은 음성' },
    { type: 'END' },
  ]) state = act(state, action.type, action)
  assert.deepEqual(completedRecord(state, 'empty-record'), record)
  assert.equal(record.messages.length, 0)
  assert.ok(!JSON.stringify(record).includes('아직 제출'))
  assert.equal(completedRecord(initialState, 'not-finished'), null)
})

test('elapsed timestamps and total duration exclude pauses; only the ended session is archived', () => {
  let state = act(initialState, 'START', { topic: decisionTopic, timestamp: 1000 })
  state = act(state, 'AI_READY', { text: '첫 발언', timestamp: 6000 })
  state = act(state, 'PAUSE', { timestamp: 7000 })
  state = act(state, 'RESUME', { timestamp: 17000 })
  state = act(state, 'USER_START', { timestamp: 18000 })
  state = act(state, 'DRAFT', { text: '두 번째 발언' })
  state = act(state, 'USER_FINISH', { timestamp: 19000 })
  state = act(state, 'END', { timestamp: 20000 })
  const first = completedRecord(state, 'session-one')
  assert.equal(first.durationMs, 9000)
  assert.deepEqual(first.messages.map(m => m.elapsedMs), [5000, 8000])
  state = act(state, 'START', { topic: practiceTopics[0], timestamp: 21000 })
  state = act(state, 'AI_READY', { text: '새 주제 발언', timestamp: 26000 })
  state = act(state, 'PAUSE', { timestamp: 27000 })
  state = act(state, 'END', { timestamp: 30000 })
  const second = completedRecord(state, 'session-two')
  assert.equal(second.messages.length, 1)
  assert.equal(second.messages[0].order, 1)
  assert.equal(second.messages[0].turnId, 3)
  assert.equal(second.durationMs, 6000)
  assert.equal(first.messages.length, 2)
})

test('storage survives a new library instance; repeated captures/retries cannot duplicate records', () => {
  const memory = memoryStorage()
  const repository = createLocalRecordRepository(() => memory.storage)
  const library = createRecordLibrary(repository)
  const record = completedRecord(ended(), 'stable-id')
  library.capture(record)
  library.capture(record)
  library.retry(record.id)
  repository.save(record)
  assert.equal(memory.writes, 1)
  const reloaded = createRecordLibrary(createLocalRecordRepository(() => memory.storage))
  assert.deepEqual(reloaded.getSnapshot().entries[0].record, record)
  assert.equal(reloaded.getSnapshot().entries[0].saved, true)
})

test('quota failure preserves unsaved originals through refresh/new debates, then retries successfully', () => {
  const memory = memoryStorage()
  const library = createRecordLibrary(createLocalRecordRepository(() => memory.storage))
  const record = completedRecord(ended(), 'quota-id')
  memory.failSave(true)
  library.capture(record)
  library.refresh()
  assert.deepEqual(library.getSnapshot().entries[0].record, record)
  assert.equal(library.getSnapshot().entries[0].saved, false)
  assert.match(library.getSnapshot().entries[0].error, /저장하지 못했습니다/)
  library.capture(completedRecord(ended(), 'next-id'))
  assert.equal(library.getSnapshot().entries.length, 2)
  memory.failSave(false)
  library.retry(record.id)
  assert.equal(library.getSnapshot().entries.find(entry => entry.record.id === record.id).saved, true)
  assert.equal(library.getSnapshot().entries.find(entry => entry.record.id === 'next-id').saved, false)
})

test('failed deletes keep records; successful deletes persist and never resurrect on repeated capture', () => {
  const memory = memoryStorage()
  const repository = createLocalRecordRepository(() => memory.storage)
  const library = createRecordLibrary(repository)
  const record = completedRecord(ended(), 'delete-id')
  library.capture(record)
  memory.failRemove(true)
  assert.equal(library.remove(record.id), false)
  assert.equal(library.getSnapshot().entries.length, 1)
  assert.match(library.getSnapshot().entries[0].error, /삭제하지 못했습니다/)
  memory.failRemove(false)
  assert.equal(library.remove(record.id), true)
  library.capture(record)
  library.refresh()
  assert.equal(library.getSnapshot().entries.length, 0)
  assert.equal(createRecordLibrary(repository).getSnapshot().entries.length, 0)
})

test('read errors, malformed records and future versions are reported without removing originals', () => {
  const memory = memoryStorage()
  const repository = createLocalRecordRepository(() => memory.storage)
  memory.failRead(true)
  const library = createRecordLibrary(repository)
  assert.match(library.getSnapshot().loadError, /읽지 못했습니다/)
  memory.failRead(false)
  memory.data.set(RECORD_KEY_PREFIX + 'corrupt', '{broken')
  memory.data.set(RECORD_KEY_PREFIX + 'future', JSON.stringify({ schemaVersion: 2 }))
  library.capture(completedRecord(ended(), 'good-id'))
  library.refresh()
  assert.equal(library.getSnapshot().entries.length, 1)
  assert.match(library.getSnapshot().loadError, /2개 기록/)
  assert.equal(memory.data.get(RECORD_KEY_PREFIX + 'corrupt'), '{broken')
  assert.equal(memory.data.size, 3)
})

test('archive allowlist excludes secrets and rejects broken order or duplicate message IDs', () => {
  const record = completedRecord(ended(), 'safe-id')
  const injected = { ...record, token: 'secret', password: 'secret', pending: 'secret',
    topic: { ...record.topic, auth: 'secret' }, messages: record.messages.map(m => ({ ...m, authorization: 'secret' })) }
  assert.ok(!JSON.stringify(parseRecord(injected)).includes('secret'))
  assert.throws(() => parseRecord({ ...record, messages: [...record.messages].reverse() }))
  assert.throws(() => parseRecord({ ...record, messages: [record.messages[0], { ...record.messages[1], id: record.messages[0].id }] }))
  assert.throws(() => parseRecord({ ...record, messages: [{ ...record.messages[0], isUser: true }] }))
  const memory = memoryStorage()
  const repository = createLocalRecordRepository(() => memory.storage)
  repository.save(record)
  assert.throws(() => repository.save({ ...record, topic: { ...record.topic, title: '다른 내용' } }), /덮어쓸/)
  assert.deepEqual(repository.list().records[0], record)
})

test('real scheduler cancellation and ending cannot archive late replies or trigger extra model requests', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
  const calls = []
  const provider = { generateReply(request, signal) { return new Promise(resolve => calls.push({ request, signal, resolve })) } }
  let state = initialState
  let cancel = () => {}
  const send = action => {
    const next = debateReducer(state, { generationId: state.generationId, timestamp: Date.now(), ...action })
    if (next === state) return
    state = next
    cancel()
    cancel = scheduleTurn(state, send, provider)
  }
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
  t.after(() => cancel())
  send({ type: 'START', topic: decisionTopic })
  await flush()
  send({ type: 'USER_START' })
  send({ type: 'DRAFT', text: '확정한 사용자 발언' })
  send({ type: 'USER_FINISH' })
  await flush()
  const generation = state.generationId
  send({ type: 'END' })
  const record = completedRecord(state, 'cancelled-turns')
  calls.forEach(call => { assert.equal(call.signal.aborted, true); call.resolve({ text: '늦은 답변' }) })
  t.mock.timers.tick(60000)
  await flush()
  send({ type: 'AI_READY', generationId: generation, text: '무효화된 답변' })
  assert.deepEqual(completedRecord(state, 'cancelled-turns'), record)
  assert.equal(record.messages.length, 1)
  assert.equal(calls.length, 2)
  const memory = memoryStorage()
  const repository = createLocalRecordRepository(() => memory.storage)
  createRecordLibrary(repository).refresh()
  recordText(record)
  assert.equal(calls.length, 2)
})
