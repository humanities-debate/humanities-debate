import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createChromeServer } from '../desktop/chrome-server.mjs'
import { siwcPaths, accountScope, publicAccounts } from '../desktop/siwc-accounts.mjs'
import { createSIWCRuntime, siwcModelChoices, siwcError } from '../server/siwcRuntime.mjs'
import { backupRecords, parseBackup, importRecords } from '../src/records/transfer.ts'
import { createLocalRecordRepository } from '../src/records/repository.ts'
import { fixtureRecord, fixtureFeedback, fixtureContent } from './fixtures/feedback.mjs'
import { validateRequest, replySchema } from '../server/dialogue.mjs'
import { stancePlan } from '../server/stances.mjs'
import { stanceReviewSchema } from '../server/stanceApproval.mjs'
import { feedbackSchema } from '../server/feedback.mjs'

const models = [{ model: 'gpt-6-luna', displayName: 'Luna', reasoningEfforts: ['low', 'medium', 'high'] }]
const settings = { model: 'gpt-6-luna', reasoningEffort: 'medium', preset: 'debate-standard' }
const input = () => validateRequest({ speakerId: 'ai2', topic: '연습 질문', history: [], modelSettings: settings })
function storageFixture() {
  const map = new Map(); let writes = 0, failAt = Infinity
  const storage = { get length() { return map.size }, key: i => [...map.keys()][i], getItem: key => map.get(key) ?? null,
    setItem(key, value) { if (++writes === failAt) throw new Error('quota'); map.set(key, value) }, removeItem: key => map.delete(key) }
  return { map, storage, failOnWrite: value => { failAt = value } }
}
test('8F account identities and registrations isolate paths; legacy 0.0.7 is a separate preserved tree', () => {
  const base = { root: path.resolve('.'), appData: path.resolve('fixture-user'), packaged: true }
  const a = siwcPaths({ ...base, profile: 'A' }), b = siwcPaths({ ...base, profile: 'B' })
  assert.notEqual(a.dataRoot, b.dataRoot); assert.ok(!a.legacy.startsWith(a.dataRoot + path.sep))
  assert.match(a.legacy, /HumanitiesDebateChrome/); assert.match(a.dataRoot, /HumanitiesDebateSIWC/)
  for (const profile of ['../A', 'CON', 'A/B', 'nul']) assert.throws(() => siwcPaths({ ...base, profile }))
  const session = { status: 'connected', sharing: true, profileId: 'p' }
  const saved = subject => ({ activeProfileId: 'p', profiles: [{ id: 'p', subject, clientId: 'registration', status: 'connected', credentials: {}, scopes: ['chatgpt.tokens.use.direct'] }] })
  assert.notEqual(accountScope(saved('a'), session), accountScope(saved('b'), session))
  const another = saved('a'); another.profiles[0].clientId = 'different-registration'
  assert.notEqual(accountScope(saved('a'), session), accountScope(another, session))
  assert.throws(() => accountScope(saved('a'), { ...session, sharing: false }))
  const profiles = publicAccounts([{ id: 'p', label: 'Connection 1', identity: { email: 'display@example.invalid' }, subject: 'private', accessToken: 'secret' }])
  assert.equal(profiles[0].subject, undefined); assert.equal(profiles[0].accessToken, undefined)
})
test('8F live SIWC catalog uses returned model IDs and declared efforts, without invented capabilities', () => {
  const result = siwcModelChoices([{ slug: 'returned-id', displayName: 'Returned', supportedReasoningEfforts: [{ effort: 'medium' }, { effort: 'high' }] },
    { slug: 'unknown-capabilities', supportedReasoningEfforts: [] }])
  assert.deepEqual(result, [{ model: 'returned-id', displayName: 'Returned', reasoningEfforts: ['medium', 'high'] }])
})
test('8F transport preserves selected settings with bounded initial plan and speech approval', async () => {
  let calls = 0
  const runtime = createSIWCRuntime({ models, accountScope: 'a', getAccountScope: async () => 'a', client: {
    async streamResponse(options) {
      calls++; assert.equal(options.model, settings.model); assert.equal(options.reasoningEffort, 'medium')
      if (options.outputSchema.properties.opposed) return { text: JSON.stringify({ A: '제안한 기준을 채택해야 한다', B: '제안한 기준을 채택하지 않아야 한다', opposed: true }) }
      if (options.outputSchema === stanceReviewSchema) return { text: JSON.stringify({ position: stancePlan('연습 질문').sides.ai2, evidence: '이 기준에는 다른 문제가 있습니다.', contradicts: false }) }
      assert.deepEqual(options.outputSchema, replySchema); assert.match(options.input, /이서연/)
      assert.match(options.input, /연습 질문/)
      assert.match(options.instructions, /이번에 말할 사람은 이서연/)
      assert.match(options.instructions, /쉬운 구어체 존댓말/)
      assert.equal(JSON.parse(options.input).nextSpeaker, 'ai2')
      return { text: JSON.stringify({ speakerId: 'ai2', text: '이 기준에는 다른 문제가 있습니다.' }) }
    },
  } })
  const response = await runtime.generate(input(), new AbortController().signal)
  assert.equal(response.model, settings.model); assert.equal(response.reasoningEffort, 'medium'); assert.equal(calls, 3)
  await assert.rejects(runtime.generate({ ...input(), modelSettings: { ...settings, model: 'unsupported' } }, new AbortController().signal), /UNSUPPORTED_MODEL_SETTINGS/)
  assert.equal(calls, 3)
})
test('8F feedback reuses all evidence validation and passes schema and high reasoning', async () => {
  const record = fixtureRecord(), modelSettings = { model: 'gpt-6-luna', reasoningEffort: 'high', preset: 'feedback-standard' }
  const runtime = createSIWCRuntime({ models, accountScope: 'a', getAccountScope: async () => 'a', client: { async streamResponse(options) {
    assert.equal(options.reasoningEffort, 'high'); assert.deepEqual(options.outputSchema, feedbackSchema)
    assert.match(options.instructions, /관찰 가능한 수행/)
    assert.ok(!options.instructions.includes(record.messages[1].text))
    for (const message of record.messages) assert.ok(options.input.includes(message.id))
    return { text: JSON.stringify(fixtureContent()) }
  } } })
  const result = await runtime.analyze({ record, modelSettings }, new AbortController().signal)
  assert.equal(result.feedback.categories.length, 5)
  assert.equal(result.feedback.recordId, record.id)
})
test('8F late responses are discarded after account change even when transport ignores abort', async () => {
  let account = 'a', finish, began
  const started = new Promise(resolve => { began = resolve })
  const runtime = createSIWCRuntime({ models, accountScope: 'a', getAccountScope: async () => account, client: { streamResponse: () => {
    began(); return new Promise(resolve => { finish = resolve })
  } } })
  const reply = runtime.generate(input(), new AbortController().signal)
  const rejected = assert.rejects(reply, /CANCELLED/)
  await started; account = 'b'
  finish({ text: JSON.stringify({ speakerId: 'ai2', text: 'Must be discarded' }) })
  await rejected
})
test('8F account lifecycle cancellation invalidates queued and active work', async () => {
  let finish, began
  const started = new Promise(resolve => { began = resolve })
  const runtime = createSIWCRuntime({ models, accountScope: 'a', getAccountScope: async () => 'a', client: { streamResponse: options => {
    began(); return new Promise(resolve => { finish = () => { assert.equal(options.signal.aborted, true); resolve({ text: '{}' }) } })
  } } })
  const reply = runtime.generate(input(), new AbortController().signal), rejected = assert.rejects(reply, /CANCELLED/)
  await started; runtime.cancel(); finish(); await rejected
  await assert.rejects(runtime.generate(input(), new AbortController().signal), /CANCELLED/)
})
test('8F auth, usage, network and unsupported setting errors remain explicit, with no fallback request', () => {
  for (const [error, expected] of [[{ code: 'invalid_grant' }, 'CHATGPT_LOGIN_REQUIRED'], [{ status: 429 }, 'LIMIT'],
    [{ code: 'sharing_not_enabled' }, 'SHARING_REQUIRED'], [{ code: 'network_error' }, 'NETWORK'], [{ status: 400 }, 'UNSUPPORTED_MODEL_SETTINGS']]) assert.equal(siwcError(error).code, expected)
})
test('8F backup restores transcript and 100-point feedback without modifying source or duplicating import', () => {
  const from = storageFixture(), to = storageFixture(), record = fixtureRecord(); record.feedback = fixtureFeedback()
  createLocalRecordRepository(() => from.storage).save(record)
  const before = [...from.map]
  const records = parseBackup(JSON.stringify(backupRecords(from.storage)))
  assert.deepEqual(importRecords(to.storage, records), { copied: 1, existing: 0 })
  assert.deepEqual(importRecords(to.storage, records), { copied: 0, existing: 1 })
  assert.deepEqual(createLocalRecordRepository(() => to.storage).list().records[0], record)
  assert.deepEqual([...from.map], before)
})
test('8F import rejects ID conflicts before writing; quota failure rolls back only its own copies', () => {
  const f = storageFixture(), a = fixtureRecord(), b = { ...fixtureRecord(), id: 'other-record' }
  f.failOnWrite(2)
  assert.throws(() => importRecords(f.storage, [a, b]), /취소/)
  assert.equal(f.map.size, 0)
  importRecords(f.storage, [a])
  assert.throws(() => importRecords(f.storage, [b, { ...a, durationMs: a.durationMs + 1 }]), /같은 ID/)
  assert.equal(f.map.size, 1)
})
test('8F backup preserves unknown originals but import never trusts malformed records or non-record keys', () => {
  const f = storageFixture(); f.map.set('skhynix-debate:record:broken', '{broken'); f.map.set('other-private-value', 'must not export')
  const backup = backupRecords(f.storage)
  assert.equal(backup.items.length, 1); assert.equal(backup.items[0].value, '{broken')
  assert.throws(() => parseBackup(JSON.stringify(backup)))
  assert.throws(() => parseBackup(JSON.stringify({ ...backup, items: [{ key: 'auth.json', value: '{}' }] })))
  assert.equal(f.map.get('skhynix-debate:record:broken'), '{broken')
})
test('8F gateway protects account changes and denies unconnected app access, arbitrary actions and cross-origin requests', async t => {
  const calls = []
  const gateway = createChromeServer({ dist: path.resolve('dist'), portal: path.resolve('desktop/chrome-siwc'), secret: 'fixture',
    getBackend: () => undefined, getStatus: () => ({ phase: 'login-required' }), allowApp: () => false,
    extraActions: ['select-account'], action: (name, body) => { calls.push({ name, body }); return { ok: true } } })
  await new Promise(resolve => gateway.server.listen(0, '127.0.0.1', resolve))
  t.after(() => { gateway.server.closeAllConnections(); gateway.server.close() })
  const base = `http://127.0.0.1:${gateway.server.address().port}`
  const claimed = await fetch(base + '/launcher/claim', { method: 'POST', headers: { 'X-Launch-Capability': gateway.capability } })
  const headers = { Cookie: claimed.headers.get('set-cookie').split(';')[0], 'X-Launch-Client': 'local-ui', 'Content-Type': 'application/json' }
  assert.equal((await fetch(base + '/app', { headers })).status, 404)
  assert.equal((await fetch(base + '/launcher/select-account', { method: 'POST', headers: { ...headers, Origin: 'https://attacker.invalid' }, body: '{}' })).status, 403)
  assert.equal((await fetch(base + '/launcher/select-account', { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' })).status, 400)
  assert.equal((await fetch(base + '/launcher/exec', { method: 'POST', headers, body: '{}' })).status, 404)
  assert.equal((await fetch(base + '/launcher/select-account', { method: 'POST', headers, body: JSON.stringify({ profileId: 'fixture' }) })).status, 200)
  assert.deepEqual(calls, [{ name: 'select-account', body: { profileId: 'fixture' } }])
})
