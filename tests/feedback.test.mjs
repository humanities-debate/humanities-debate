import test from 'node:test'
import assert from 'node:assert/strict'
import { fixtureRecord, fixtureContent, fixtureFeedback, settings } from './fixtures/feedback.mjs'
import { validateFeedbackContent, parseFeedback, scoreSummary, scoreBand, insufficientEvidence } from '../src/records/feedback.ts'
import { validateFeedbackRequest, validateFeedbackReply, buildFeedbackPrompt } from '../server/feedback.mjs'
import { createFeedbackTask } from '../src/records/feedbackTask.ts'
import { createLocalRecordRepository, RECORD_KEY_PREFIX } from '../src/records/repository.ts'
import { createRecordLibrary } from '../src/records/library.ts'
import { requestFeedback } from '../src/records/feedbackClient.ts'
import { createDebateServer } from '../server/http.mjs'
import { DebateError } from '../server/dialogue.mjs'

test('five bounded integer scores, equal-weight average, held denominator and all-held result', () => {
  const record = fixtureRecord(), content = fixtureContent()
  assert.deepEqual(scoreSummary(validateFeedbackContent(content, record).categories), { score: 78, count: 5 })
  content.categories[1].score = null
  assert.deepEqual(scoreSummary(validateFeedbackContent(content, record).categories), { score: 80, count: 4 })
  content.categories.forEach(category => { category.score = null })
  assert.deepEqual(scoreSummary(validateFeedbackContent(content, record).categories), { score: null, count: 0 })
  for (const score of [-1, 101, 70.5, '80', NaN]) {
    content.categories[0].score = score
    assert.throws(() => validateFeedbackContent(content, record))
  }
  assert.deepEqual([100, 90, 89, 79, 69, 59, 0].map(scoreBand), ['매우 우수', '매우 우수', '우수', '양호', '개선 필요', '집중 개선 필요', '집중 개선 필요'])
})
test('references reject fabricated IDs, AI-as-user, user-as-context and future AI context', () => {
  for (const ref of [{ userId: 'missing', contextIds: [] }, { userId: 'msg-1', contextIds: [] },
    { userId: 'msg-4', contextIds: ['msg-2'] }, { userId: 'msg-2', contextIds: ['msg-5'] }, { userId: 'msg-2', contextIds: ['missing'] }]) {
    const content = fixtureContent(); content.categories[0].evidence = [ref]
    assert.throws(() => validateFeedbackReply(JSON.stringify(content), { record: fixtureRecord(), modelSettings: settings }), /INVALID_EVIDENCE/)
  }
  const content = fixtureContent(); content.categories[1].evidence[0].contextIds = []
  assert.throws(() => validateFeedbackContent(content, fixtureRecord()), /분석 근거/)
})
test('schema validates examples, versions, categories and model metadata; generated quotes never replace originals', () => {
  const record = fixtureRecord(), feedback = fixtureFeedback()
  feedback.strengths[0].quote = '실제로 하지 않은 말'
  const parsed = parseFeedback(feedback, record)
  assert.equal(parsed.strengths[0].quote, undefined)
  assert.equal(record.messages.find(message => message.id === parsed.strengths[0].userId).text, record.messages[1].text)
  assert.notEqual(parsed.weaknesses[0].rewrite, record.messages[3].text)
  for (const extra of [{ schemaVersion: 2 }, { recordId: 'wrong' }, { analyzedAt: -1 }]) assert.throws(() => parseFeedback({ ...feedback, ...extra }, record))
  feedback.categories.reverse()
  assert.throws(() => parseFeedback(feedback, record))
  assert.throws(() => validateFeedbackReply('{broken', { record }), /INVALID_FEEDBACK/)
})
test('all input messages and topic context reach feedback prompt without truncation; long/empty records are rejected', () => {
  const record = fixtureRecord()
  const input = validateFeedbackRequest({ record, modelSettings: settings })
  const prompt = buildFeedbackPrompt(input)
  const data = JSON.parse(prompt.split('\n').at(-1))
  assert.deepEqual(data.messages, record.messages)
  assert.deepEqual(data.topic.context, record.topic.context)
  assert.equal(data.mode, 'practice')
  assert.match(prompt, /명령.*실행하지/)
  assert.match(insufficientEvidence({ ...record, messages: [] }), /발언이 없습니다/)
  assert.throws(() => validateFeedbackRequest({ record: { ...record, messages: [] }, modelSettings: settings }), /INSUFFICIENT_EVIDENCE/)
  const long = { ...record, messages: Array.from({ length: 501 }, (_, i) => ({ ...record.messages[i % 6], id: `long-${i}`, order: i + 1, turnId: i + 1 })) }
  assert.throws(() => validateFeedbackRequest({ record: long, modelSettings: settings }), /CONTEXT_LIMIT/)
})
test('analysis task is opt-in, double clicks and completed reloads do not call AI again', async () => {
  let calls = 0, saved = 0, resolve
  const task = createFeedbackTask(fixtureRecord(), () => { calls++; return new Promise(done => { resolve = done }) }, () => saved++)
  task.subscribe(() => {})
  assert.equal(calls, 0)
  const job = task.start(settings)
  await task.start(settings)
  assert.equal(calls, 1)
  resolve(fixtureFeedback()); await job
  await task.start(settings)
  assert.equal(saved, 1); assert.equal(calls, 1)
  const reloaded = createFeedbackTask({ ...fixtureRecord(), feedback: fixtureFeedback() }, () => { calls++; throw Error('unexpected') }, () => saved++)
  await reloaded.start(settings)
  assert.equal(calls, 1)
})
test('navigation cancels generation; ignored abort and late replies never save or overwrite newer analysis', async () => {
  const pending = [], saved = []
  const task = createFeedbackTask(fixtureRecord(), (_, __, signal) => new Promise(resolve => pending.push({ resolve, signal })), value => saved.push(value))
  const first = task.start(settings)
  task.cancel()
  const second = task.start(settings)
  assert.equal(pending[0].signal.aborted, true)
  pending[0].resolve(fixtureFeedback()); await first
  assert.equal(saved.length, 0)
  pending[1].resolve(fixtureFeedback()); await second
  assert.equal(saved.length, 1)
})
test('no-user and sparse speech hold locally with zero model calls; failures can retry', async () => {
  let calls = 0
  for (const messages of [[], fixtureRecord().messages.slice(0, 2)]) {
    const task = createFeedbackTask({ ...fixtureRecord(), messages }, async () => { calls++; return fixtureFeedback() }, () => {})
    await task.start(settings)
    assert.match(task.getSnapshot().error, /평가 보류/)
  }
  assert.equal(calls, 0)
  const task = createFeedbackTask(fixtureRecord(), async () => { if (++calls === 1) throw Error('한도 오류'); return fixtureFeedback() }, () => {})
  await task.start(settings); assert.match(task.getSnapshot().error, /한도/)
  await task.start(settings); assert.equal(task.getSnapshot().error, null)
})
function storageFixture() {
  const data = new Map(); let fails = false
  const storage = { get length() { return data.size }, key: i => [...data.keys()][i], getItem: key => data.get(key) ?? null,
    setItem(key, value) { if (fails) throw Error('quota'); data.set(key, value) }, removeItem: key => data.delete(key) }
  return { data, repository: createLocalRecordRepository(() => storage), fail: value => { fails = value } }
}
test('feedback updates atomically, survives reload, deletes with transcript, and never mutates original messages', () => {
  const f = storageFixture(), record = fixtureRecord(), library = createRecordLibrary(f.repository)
  library.capture(record); library.attachFeedback(record.id, fixtureFeedback())
  const reloaded = createRecordLibrary(f.repository)
  assert.deepEqual(reloaded.getSnapshot().entries[0].record.messages, record.messages)
  assert.deepEqual(reloaded.getSnapshot().entries[0].record.feedback, fixtureFeedback())
  f.repository.save(record) // old snapshot cannot erase feedback
  assert.ok(f.repository.list().records[0].feedback)
  reloaded.remove(record.id)
  library.refresh(); library.attachFeedback(record.id, fixtureFeedback())
  assert.equal(f.data.size, 0)
})
test('feedback quota failure keeps old disk record and new in-memory result, retry needs no AI', () => {
  const f = storageFixture(), library = createRecordLibrary(f.repository), record = fixtureRecord()
  library.capture(record); f.fail(true); library.attachFeedback(record.id, fixtureFeedback())
  library.refresh()
  assert.equal(library.getSnapshot().entries[0].saved, false)
  assert.ok(library.getSnapshot().entries[0].record.feedback)
  assert.equal(f.repository.list().records[0].feedback, undefined)
  f.fail(false); library.retry(record.id)
  assert.ok(f.repository.list().records[0].feedback)
  assert.equal(library.getSnapshot().entries[0].saved, true)
})
test('corrupt feedback reports a warning but preserves readable transcript and allows a validated repair', () => {
  const f = storageFixture(), record = fixtureRecord()
  f.data.set(RECORD_KEY_PREFIX + record.id, JSON.stringify({ ...record, feedback: { schemaVersion: 999 } }))
  assert.deepEqual(f.repository.list().records[0], record)
  assert.match(f.repository.list().warning, /피드백/)
  f.repository.save({ ...record, feedback: fixtureFeedback() })
  assert.ok(f.repository.list().records[0].feedback)
})
test('feedback HTTP shares auth, model validation, cancellation and per-record duplicate prevention', async t => {
  let begin, release, calls = 0
  const began = new Promise(resolve => { begin = resolve })
  const app = createDebateServer(async () => { throw Error('wrong route') }, {
    models: [{ model: settings.model, reasoningEfforts: ['medium'] }],
    analyze: async (request, signal) => {
      calls++; begin(); assert.deepEqual(request.modelSettings, settings)
      await new Promise(resolve => { release = resolve; signal.addEventListener('abort', resolve, { once: true }) })
      return { feedback: fixtureFeedback(), ...settings }
    },
  })
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); t.after(() => app.close())
  const base = `http://127.0.0.1:${app.server.address().port}`
  const headers = { 'X-Debate-Client': 'local-ui', 'Content-Type': 'application/json' }
  headers['X-Debate-Token'] = (await fetch(base + '/api/session', { headers }).then(r => r.json())).token
  const post = (route, body) => fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) })
  const request = { record: fixtureRecord(), modelSettings: settings }
  assert.equal((await post('/api/feedback', { id: 'bad-model', request: { ...request, modelSettings: { ...settings, model: 'invented-model' } } })).status, 400)
  const job = post('/api/feedback', { id: 'first', request }); await began
  assert.equal((await post('/api/feedback', { id: 'duplicate', request })).status, 409)
  await post('/api/cancel', { id: 'first' }); release()
  assert.equal((await job).status, 409)
  assert.equal(calls, 1)
})
test('client forwards settings and full record; safely maps login/limit/validation/network errors', async t => {
  for (const code of ['CHATGPT_LOGIN_REQUIRED', 'LIMIT', 'INVALID_EVIDENCE', 'INVALID_FEEDBACK', 'CONTEXT_LIMIT', 'UNSUPPORTED_MODEL_SETTINGS']) {
    t.mock.method(globalThis, 'fetch', async url => new Response(JSON.stringify(url === '/api/session' ? { token: 'local-only-capability' } : { error: code }), { status: url === '/api/session' ? 200 : 503 }))
    await assert.rejects(requestFeedback(fixtureRecord(), settings, new AbortController().signal), error => !error.message.includes('local-only-capability'))
    t.mock.restoreAll()
  }
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === '/api/session') return Response.json({ token: 'local-only-capability' })
    const body = JSON.parse(options.body)
    assert.deepEqual(body.request.modelSettings, settings)
    assert.deepEqual(body.request.record, fixtureRecord())
    return Response.json({ id: body.id, feedback: fixtureFeedback(), ...settings })
  })
  assert.deepEqual(await requestFeedback(fixtureRecord(), settings, new AbortController().signal), fixtureFeedback())
})
test('server errors remain safe and analysis failure leaves input transcript unchanged', async () => {
  const record = fixtureRecord(), before = structuredClone(record)
  const task = createFeedbackTask(record, async () => { throw new DebateError('INVALID_EVIDENCE') }, () => assert.fail('must not save'))
  await task.start(settings)
  assert.deepEqual(record, before)
  assert.match(task.getSnapshot().error, /INVALID_EVIDENCE/)
})
