import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { generateKeyPairSync, sign, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { prototypeEnvironment, allowedBrowserUrl, verifiedRecordScope, publicSession, safeError, onceOnlySmoke, selectSmokeModel } from '../experiments/siwc-8e/policy.mjs'

test('8E launch environment excludes API keys, Codex homes, provider headers and Node injection', () => {
  assert.deepEqual(prototypeEnvironment({ SystemRoot: 'Windows', OPENAI_API_KEY: 'fake', CODEX_HOME: 'old-login',
    OPENAI_CUSTOM_HEADERS: 'fake', NODE_OPTIONS: '--inspect', ELECTRON_RUN_AS_NODE: '1' }), { SystemRoot: 'Windows' })
  assert.throws(() => allowedBrowserUrl('https://auth.openai.com.attacker.invalid/api/accounts/authorize'))
  assert.throws(() => allowedBrowserUrl('file:///C:/auth.json'))
  assert.throws(() => allowedBrowserUrl('https://user:secret@auth.openai.com/api/accounts/authorize'))
  assert.equal(new URL(allowedBrowserUrl('https://auth.openai.com/api/accounts/authorize?state=fake')).hostname, 'auth.openai.com')
})
test('8E public diagnostics omit credentials, email, raw errors and authorization URLs', () => {
  const session = publicSession({ status: 'connected', sharing: true, identity: { email: 'private@example.invalid' },
    access_token: 'test-secret', profileId: 'opaque' })
  assert.equal(JSON.stringify(session).includes('private'), false)
  assert.deepEqual(safeError(new Error('raw secret body')), { code: 'PROTOTYPE_FAILED' })
  assert.deepEqual(safeError({ code: 'invalid_grant', status: 401, message: 'raw secret' }), { code: 'invalid_grant', status: 401 })
})
test('8E verified namespaces distinguish identity AND registration; never use email or pending identity', () => {
  const session = { status: 'connected', sharing: true, profileId: 'p' }
  const profile = { id: 'p', status: 'connected', subject: 'verified-a', clientId: 'registration-a', credentials: {}, scopes: ['chatgpt.tokens.use.direct'] }
  const scope = changes => verifiedRecordScope({ activeProfileId: 'p', profiles: [{ ...profile, ...changes }] }, session)
  assert.notEqual(scope({}), scope({ subject: 'verified-b' }))
  assert.notEqual(scope({}), scope({ clientId: 'registration-b' }))
  assert.equal(scope({}), scope({ identity: { email: 'changed@example.invalid' } }))
  assert.throws(() => scope({ subject: undefined }))
  assert.throws(() => scope({ pendingRefresh: {} }))
  assert.throws(() => scope({ status: 'disconnected' }))
})
test('8E one smoke attempt never queues, retries or silently substitutes a model', async () => {
  let calls = 0
  const invoke = onceOnlySmoke(async model => { calls++; assert.equal(model, 'chosen'); throw new Error('synthetic failure') })
  await assert.rejects(invoke('chosen'))
  await assert.rejects(invoke('different'), /SMOKE_ALREADY_ATTEMPTED/)
  assert.equal(calls, 1)
  assert.equal(selectSmokeModel([{ slug: 'catalog-only' }]).slug, 'catalog-only')
})

const bundle = path.resolve('.codex-debate/siwc-8e-build/official-sdk.mjs')
const sdkTest = (name, fn) => test(name, { skip: !existsSync(bundle) && 'Run npm run siwc:prepare to test the pinned official SDK' }, fn)
const realFetch = globalThis.fetch
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256', use: 'sig' }
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
function idToken(clientId, nonce, subject) {
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture-key' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ iss: 'https://auth.openai.com', sub: subject, aud: clientId,
    iat: now, exp: now + 3600, nonce, email: 'same@example.invalid' })).toString('base64url')
  return header + '.' + payload + '.' + sign('RSA-SHA256', Buffer.from(header + '.' + payload), keys.privateKey).toString('base64url')
}
// All OAuth, model and inference traffic below is synthetic. Only callback HTTP is real loopback.
async function fixture(t, options = {}) {
  const { createChatGPT, ConnectionStore } = await import(pathToFileURL(options.bundle || bundle).href)
  const parent = path.resolve('.codex-debate/siwc-8e-fixtures')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(path.join(parent, 'test-'))
  const key = randomBytes(32)
  const encryption = { id: 'fixture-aes-gcm-not-windows', isAvailable: () => true,
    encrypt: plaintext => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]) },
    decrypt: bytes => { const data = Buffer.from(bytes), cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12))
      cipher.setAuthTag(data.subarray(12, 28)); return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8') } }
  const calls = { refresh: 0, inference: 0, revoked: 0 }
  let nonce, sequence = 0, clientId
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.hostname === '127.0.0.1') return realFetch(input, init)
    if (url.href.endsWith('/.well-known/openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com',
      authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize', token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token',
      jwks_uri: 'https://auth.openai.com/fixture-jwks', revocation_endpoint: 'https://auth.openai.com/fixture-revoke' })
    if (url.pathname === '/fixture-jwks') return Response.json({ keys: [jwk] })
    if (url.pathname.endsWith('/oauth/token')) {
      const fields = new URLSearchParams(init.body)
      if (fields.get('grant_type') === 'refresh_token') calls.refresh++
      return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'Bearer', expires_in: 3600,
        scope: scopes, id_token: idToken(fields.get('client_id'), options.wrongNonce ? 'wrong' : nonce, options.subject || 'fixture-subject-a') })
    }
    if (url.pathname === '/fixture-revoke') {
      assert.equal(new URLSearchParams(init.body).get('client_id'), clientId); calls.revoked++
      return new Response(null, { status: 200 })
    }
    if (url.href === 'https://api.openai.com/v1/models') return Response.json({ models: [{ slug: 'fixture-model', display_name: 'Synthetic model', visibility: 'list' }] })
    if (url.href === 'https://api.openai.com/v1/responses') {
      calls.inference++
      const body = JSON.parse(init.body)
      assert.equal(body.store, false); assert.equal(body.stream, true); assert.equal(body.model, 'fixture-model')
      assert.equal(body.tools, undefined)
      options.inspectRequest?.(body)
      if (options.apiError) return Response.json({ error: { code: options.apiError, message: 'synthetic-private-body' } }, { status: options.apiStatus || 400 })
      if (options.waitForAbort) return new Promise((_, reject) => {
        options.started?.()
        init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      })
      const events = [{ type: 'response.output_text.delta', delta: 'Synthetic response, not real AI.' },
        ...(options.incomplete ? [] : [{ type: 'response.completed', response: { status: 'completed' } }])]
      return new Response(events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''),
        { headers: { 'content-type': 'text/event-stream' } })
    }
    throw new Error('Unexpected network request in isolated fixture')
  }
  const client = createChatGPT({ appName: 'Synthetic fixture', appId: 'siwc-fixture', storageDir: directory,
    redirectPort: 0, sendHostId: true, credentialEncryption: encryption,
    openBrowser: async value => {
      const url = new URL(value)
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
      assert.match(url.searchParams.get('ext_agent_host_id'), /^urn:uuid:/)
      nonce = url.searchParams.get('nonce')
      clientId = url.searchParams.get('client_id')
      if (clientId === 'dynamic_agent_client') clientId = 'oaiapp_fixture_' + (++sequence)
      const callback = new URL(url.searchParams.get('redirect_uri'))
      callback.search = new URLSearchParams({ state: 'wrong-state', code: 'synthetic-code', client_id: clientId })
      assert.equal((await realFetch(callback)).status, 400)
      callback.searchParams.set('state', url.searchParams.get('state'))
      assert.equal((await realFetch(callback)).status, 200)
    } })
  const store = new ConnectionStore(directory, encryption)
  t.after(async () => {
    client.cancelSignIn(); globalThis.fetch = realFetch
    assert.equal(path.dirname(directory), parent)
    await rm(directory, { recursive: true, force: true })
  })
  return { client, store, calls, options, directory }
}
sdkTest('8E official SDK verifies signed identity, rejects wrong state, encrypts credentials and completes a synthetic SSE response', async t => {
  const f = await fixture(t)
  const session = await f.client.signIn()
  assert.equal(session.sharing, true)
  const saved = await f.store.withLock(() => f.store.read())
  assert.match(verifiedRecordScope(saved, session), /^[a-f0-9]{64}$/)
  const raw = await readFile(path.join(f.directory, 'chatgpt-auth.json'), 'utf8')
  assert.equal(raw.includes('fixture-access'), false); assert.equal(JSON.parse(raw).version, 3)
  const reply = await f.client.streamResponse({ model: 'fixture-model', input: 'Synthetic question' })
  assert.match(reply.text, /Synthetic/); assert.equal(f.calls.inference, 1)
})
sdkTest('8E official SDK rejects a signed token with wrong nonce without creating a verified account', async t => {
  const f = await fixture(t, { wrongNonce: true })
  await assert.rejects(f.client.signIn(), error => error.code === 'invalid_id_token')
  assert.equal((await f.client.getSession()).sharing, false)
  const saved = await f.store.withLock(() => f.store.read())
  assert.equal(saved.profiles.length, 0); assert.equal(saved.pendingRegistrations.length, 1)
})
sdkTest('8E official SDK keeps same-email registrations separate and rejects identity changes on reauthorization', async t => {
  const f = await fixture(t)
  const a = await f.client.signIn()
  const first = verifiedRecordScope(await f.store.withLock(() => f.store.read()), a)
  const b = await f.client.signIn({ newProfile: true })
  assert.notEqual(a.profileId, b.profileId)
  assert.notEqual(first, verifiedRecordScope(await f.store.withLock(() => f.store.read()), b))
  f.options.subject = 'fixture-subject-b'
  await assert.rejects(f.client.signIn(), error => error.code === 'account_mismatch')
  assert.equal((await f.client.listProfiles()).length, 2)
})
sdkTest('8E official SDK serializes refresh rotation and revokes before clearing credentials', async t => {
  const f = await fixture(t)
  await f.client.signIn()
  await f.store.withLock(async () => { const saved = await f.store.read(); saved.profiles[0].credentials.expiresAt = Date.now() - 1000; await f.store.write(saved) })
  await Promise.all([f.client.listModels(), f.client.listModels()])
  assert.equal(f.calls.refresh, 1)
  await f.client.disconnect()
  assert.equal(f.calls.revoked, 1)
  const saved = await f.store.withLock(() => f.store.read())
  assert.equal(saved.profiles[0].credentials, undefined)
  assert.equal(saved.profiles[0].subject, 'fixture-subject-a')
  await assert.rejects(f.client.listModels(), error => error.code === 'sign_in_required')
})
sdkTest('8E official SDK never reports an unfinished SSE response as success', async t => {
  const f = await fixture(t, { incomplete: true })
  await f.client.signIn()
  await assert.rejects(f.client.streamResponse({ model: 'fixture-model', input: 'Fixture' }), error => error.code === 'stream_interrupted')
})
sdkTest('8E official SDK aborts in-flight inference on account selection and discards its late result', async t => {
  let started
  const ready = new Promise(resolve => { started = resolve })
  const f = await fixture(t, { waitForAbort: true, started })
  const session = await f.client.signIn()
  const request = f.client.streamResponse({ model: 'fixture-model', input: 'Fixture' })
  const rejected = assert.rejects(request, error => error.code === 'cancelled')
  await ready
  await f.client.selectProfile(session.profileId)
  await rejected
  assert.equal(f.calls.inference, 1)
})

const integratedBundle = path.resolve('desktop-dist/siwc/sdk.mjs')
test('8F bundled official auth transports instructions, reasoning and JSON schema, preserving safe API errors across the SDK boundary', { skip: !existsSync(integratedBundle) }, async t => {
  const schema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }
  const f = await fixture(t, { bundle: integratedBundle, inspectRequest: body => {
    assert.deepEqual(body.reasoning, { effort: 'high' })
    assert.deepEqual(body.text.format, { type: 'json_schema', name: 'debate_response', strict: true, schema })
    assert.deepEqual(body.input, [{ role: 'user', content: 'Synthetic question' }])
    assert.equal(body.instructions, 'Synthetic trusted policy')
  } })
  await f.client.signIn()
  const options = { model: 'fixture-model', input: 'Synthetic question', instructions: 'Synthetic trusted policy', reasoningEffort: 'high', outputSchema: schema }
  assert.match((await f.client.streamResponse(options)).text, /Synthetic/)
  f.options.apiError = 'unsupported_value'
  await assert.rejects(f.client.streamResponse(options), error => error.code === 'unsupported_value' && error.status === 400 && !error.message.includes('private'))
  f.options.apiError = 'subscription_sharing_usage_limit_exceeded'; f.options.apiStatus = 429
  await assert.rejects(f.client.streamResponse(options), error => error.code === f.options.apiError && error.status === 429)
  assert.equal(f.calls.inference, 3) // No automatic retries or model fallback.
})
