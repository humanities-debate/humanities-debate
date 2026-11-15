import test from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import path from 'node:path'
import { createChromeServer } from '../desktop/chrome-server.mjs'
import { createDebateServer } from '../server/http.mjs'
import { chromeProfilePaths } from '../desktop/chrome-profile.mjs'
import { chromeStartupMessage } from '../desktop/chrome-errors.mjs'

test('Chrome gateway isolates launch sessions, rejects cross-origin requests and private files', async t => {
  const actions = []
  const app = createChromeServer({ dist: path.resolve('dist'), portal: path.resolve('desktop/chrome'),
    getBackend: () => undefined, getStatus: () => ({ phase: 'login-required' }), action: async name => actions.push(name), secret: 'test-only' })
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  t.after(() => { app.server.closeAllConnections(); app.server.close() })
  const origin = `http://127.0.0.1:${app.server.address().port}`
  const fetchLocal = (route, options) => fetch(origin + route, options)
  assert.equal((await fetchLocal('/api/session')).status, 403)
  assert.equal((await fetchLocal('/launcher/claim', { method: 'POST', headers: { 'X-Launch-Capability': app.capability, Origin: 'https://attacker.invalid' } })).status, 403)
  const claim = await fetchLocal('/launcher/claim', { method: 'POST', headers: { 'X-Launch-Capability': app.capability } })
  assert.equal(claim.status, 200)
  const cookie = claim.headers.get('set-cookie').split(';')[0]
  assert.match(claim.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/)
  assert.equal((await fetchLocal('/launcher/claim', { method: 'POST', headers: { 'X-Launch-Capability': app.capability } })).status, 403)
  const headers = { Cookie: cookie, 'X-Launch-Client': 'local-ui', 'X-Debate-Client': 'local-ui' }
  assert.equal((await fetchLocal('/launcher/status', { headers })).status, 200)
  assert.equal((await fetchLocal('/launcher/logout', { method: 'POST', headers: { Cookie: cookie } })).status, 403)
  assert.equal((await fetchLocal('/launcher/logout', { method: 'POST', headers })).status, 200)
  assert.deepEqual(actions, ['logout'])
  for (const route of ['/auth.json', '/.codex-debate/auth.json', '/assets/../../package.json', '/api/arbitrary', '/launcher/exec']) {
    assert.equal((await fetchLocal(route, { headers })).status, 404)
  }
  assert.equal((await fetchLocal('/api/session', { headers })).status, 503)
  assert.equal((await fetchLocal('/api/session', { headers: { Cookie: cookie } })).status, 403)
  assert.equal((await fetchLocal('/api/turn', { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' })).status, 400)
  assert.equal((await fetchLocal('/api/session', { headers: { ...headers, Origin: 'null' } })).status, 403)
  assert.equal((await fetchLocal('/api/turn', { method: 'OPTIONS', headers: { Origin: 'https://hostile.invalid' } })).status, 403)
  const crossSite = await fetchLocal('/api/session', { headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' } })
  assert.equal(crossSite.status, 403)
  assert.equal(crossSite.headers.get('access-control-allow-origin'), null)
  const rebound = await new Promise(resolve => { const req = request(origin, { headers: { Host: 'attacker.invalid' } }, res => { res.resume(); resolve(res.statusCode) }); req.end() })
  assert.equal(rebound, 403)
})

test('Chrome missing and startup errors give safe actionable messages', () => {
  assert.match(chromeStartupMessage('CHROME_NOT_INSTALLED'), /Chrome.*설치/)
  assert.match(chromeStartupMessage('EADDRINUSE'), /기록 보호/)
  assert.ok(!chromeStartupMessage('private-error-with-token').includes('private-error-with-token'))
})

test('Chrome packaged profiles use Windows user data and never fall back to developer paths', () => {
  const root = path.resolve('application'), user1 = path.resolve('test-user-one'), user2 = path.resolve('test-user-two')
  const a = chromeProfilePaths({ root, appData: user1, packaged: true, profile: 'A' })
  const b = chromeProfilePaths({ root, appData: user1, packaged: true, profile: 'B' })
  const other = chromeProfilePaths({ root, appData: user2, packaged: true, profile: 'A' })
  assert.ok(a.dataRoot.startsWith(user1 + path.sep))
  for (const field of ['dataRoot', 'authHome', 'browser', 'launcher']) {
    assert.notEqual(a[field], b[field]); assert.notEqual(a[field], other[field])
    assert.ok(!a[field].startsWith(root + path.sep))
  }
  for (const profile of ['../A', '..', 'A/B', 'A\\B', 'CON', 'nul', 'x'.repeat(41)]) assert.throws(() => chromeProfilePaths({ root, appData: user1, packaged: true, profile }))
  assert.throws(() => chromeProfilePaths({ root, packaged: false, verificationRoot: '../outside' }))
})

test('Separate launchers reject one another\'s cookies and capabilities', async t => {
  const fixture = () => createChromeServer({ dist: path.resolve('dist'), portal: path.resolve('desktop/chrome'), getBackend: () => undefined,
    getStatus: () => ({ phase: 'login-required' }), action: async () => {}, secret: 'test' })
  const a = fixture(), b = fixture()
  for (const app of [a, b]) {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
    t.after(() => { app.server.closeAllConnections(); app.server.close() })
  }
  const baseA = `http://127.0.0.1:${a.server.address().port}`, baseB = `http://127.0.0.1:${b.server.address().port}`
  const claim = await fetch(baseA + '/launcher/claim', { method: 'POST', headers: { 'X-Launch-Capability': a.capability } })
  const headers = { Cookie: claim.headers.get('set-cookie').split(';')[0], 'X-Launch-Client': 'local-ui' }
  assert.equal((await fetch(baseB + '/launcher/claim', { method: 'POST', headers: { 'X-Launch-Capability': a.capability } })).status, 403)
  assert.equal((await fetch(baseB + '/launcher/status', { headers })).status, 403)
  assert.equal((await fetch(baseA + '/launcher/status', { headers })).status, 200)
})

test('Chrome proxy reuses protected debate API and preserves duplicate/cancellation guards', async t => {
  let calls = 0, cancelled = false, began
  const started = new Promise(resolve => { began = resolve })
  const backend = createDebateServer(async (_, signal) => {
    calls++; began()
    await new Promise(resolve => signal.addEventListener('abort', () => { cancelled = true; resolve() }, { once: true }))
    return { speakerId: 'ai1', text: 'Discard this cancelled response' }
  }, { desktopSecret: 'server-only' })
  await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve))
  const gateway = createChromeServer({ dist: path.resolve('dist'), portal: path.resolve('desktop/chrome'), secret: 'server-only',
    getBackend: () => backend.server.address().port, getStatus: () => ({ phase: 'ready' }), action: async () => {} })
  await new Promise(resolve => gateway.server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { gateway.server.closeAllConnections(); gateway.server.close(); await backend.close() })
  const base = `http://127.0.0.1:${gateway.server.address().port}`
  const claim = await fetch(base + '/launcher/claim', { method: 'POST', headers: { 'X-Launch-Capability': gateway.capability } })
  const headers = { Cookie: claim.headers.get('set-cookie').split(';')[0], Origin: base, 'Content-Type': 'application/json', 'X-Debate-Client': 'local-ui' }
  const session = await fetch(base + '/api/session', { headers }).then(res => res.json())
  headers['X-Debate-Token'] = session.token
  const body = JSON.stringify({ id: 'cancel-test', request: { speakerId: 'ai1', topic: '교육 기회를 어떻게 나눌까요?', history: [] } })
  const ongoing = fetch(base + '/api/turn', { method: 'POST', headers, body })
  await started
  assert.equal((await fetch(base + '/api/turn', { method: 'POST', headers, body })).status, 409)
  assert.equal((await fetch(base + '/api/cancel', { method: 'POST', headers, body: JSON.stringify({ id: 'cancel-test' }) })).status, 200)
  assert.equal((await ongoing).status, 409)
  assert.equal(cancelled, true); assert.equal(calls, 1)
})
