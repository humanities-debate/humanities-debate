import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { request } from 'node:http'
import { readFile } from 'node:fs/promises'
import { isAppUrl, assetPath, apiAllowed, permissionAllowed, CSP } from '../desktop/security.mjs'
import { createDebateServer } from '../server/http.mjs'

test('desktop: only the bundled origin and contained static assets are accepted', () => {
  const root = path.resolve('dist')
  assert.equal(isAppUrl('debate://app/'), true)
  for (const value of ['https://app/', 'debate://evil/', 'debate://user@app/', 'file:///C:/secret']) assert.equal(isAppUrl(value), false)
  assert.equal(assetPath(root, 'debate://app/'), path.join(root, 'index.html'))
  for (const value of ['debate://app/%2e%2e%5csecret', 'debate://app/C%3A/secret', 'debate://app/%00', 'debate://app/%ZZ']) assert.equal(assetPath(root, value), null)
  assert.equal(apiAllowed('GET', '/api/models'), true)
  assert.equal(apiAllowed('POST', '/api/turn'), true)
  assert.equal(apiAllowed('GET', '/api/turn'), false)
  assert.equal(apiAllowed('POST', '/api/login'), false)
})
test('desktop: only microphone audio and clipboard write permissions are permitted', () => {
  assert.equal(permissionAllowed('media', 'debate://app/', ['audio']), true)
  for (const types of [[], ['video'], ['audio', 'video']]) assert.equal(permissionAllowed('media', 'debate://app/', types), false)
  assert.equal(permissionAllowed('media', 'https://example.com', ['audio']), false)
  assert.equal(permissionAllowed('geolocation', 'debate://app/'), false)
  assert.equal(permissionAllowed('clipboard-read', 'debate://app/'), false)
  assert.ok(CSP.includes("connect-src 'self'"))
  assert.ok(CSP.includes("object-src 'none'"))
})
test('desktop: every loopback API including capability discovery requires the private app secret', async () => {
  const app = createDebateServer(() => { throw new Error('must not generate') }, { desktopSecret: 'test-only-secret', models: [] })
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${app.server.address().port}`
  const headers = { 'X-Debate-Client': 'local-ui' }
  try {
    for (const route of ['/api/session', '/api/models', '/api/cancel']) assert.equal((await fetch(base + route, { headers })).status, 403)
    const trusted = { ...headers, 'X-Desktop-Secret': 'test-only-secret' }
    assert.equal((await fetch(base + '/api/session', { headers: trusted })).status, 200)
    assert.equal((await fetch(base + '/api/session', { headers: { ...trusted, Origin: 'https://evil.example' } })).status, 403)
    const hostileHost = await new Promise((resolve, reject) => {
      const req = request(base + '/api/session', { headers: { ...trusted, Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode) })
      req.on('error', reject); req.end()
    })
    assert.equal(hostileHost, 403)
  } finally { await app.close() }
})
test('desktop: packaging allowlist excludes credentials, tests, records and development servers', async () => {
  const config = JSON.parse(await readFile(new URL('../electron-builder.json', import.meta.url)))
  assert.equal(config.asar, true)
  assert.equal(config.nsis.deleteAppDataOnUninstall, false)
  assert.ok(config.extraResources.some(item => item.to === 'codex'))
  assert.ok(config.files.every(item => !item.startsWith('**') && !item.includes('.codex-debate')))
  const preload = await readFile(new URL('../desktop/preload.cjs', import.meta.url), 'utf8')
  assert.ok(!preload.includes('sendSync'))
  assert.ok(!preload.includes('child_process'))
})
