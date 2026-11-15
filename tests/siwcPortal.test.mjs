import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { startPortal } from '../desktop/chrome-siwc/portal.js'
import { attachRecordTools } from '../src/logic/launcherNavigation.ts'

const account = { id: 'fixture-a', label: 'Connection 1', email: 'local@example.invalid', status: 'connected' }
const ready = () => ({ phase: 'ready', accounts: [account], activeAccount: account })
class Element {
  hidden = false; disabled = false; textContent = ''; value = ''; dataset = {}; children = []; attributes = {}; sources = []
  set src(value) { this.sources.push(value) }
  get src() { return this.sources.at(-1) }
  setAttribute(key, value) { this.attributes[key] = value }
  focus() { this.focused = true }
  replaceChildren() { this.children = []; this.value = '' }
  append(child) { this.children.push(child); if (child.selected || this.children.length === 1) this.value = child.value }
}
function events() {
  const listeners = new Map()
  return { addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type) },
    emit: (type, value) => listeners.get(type)?.(value), listeners }
}
async function fixture(t, status = ready()) {
  const ids = ['status', 'error', 'accounts', 'settings-panel', 'settings-toggle', 'settings-close', 'connection-view', 'connection-title', 'connection-detail', 'account-info', 'primary-login', 'primary-reconnect', 'cancel-login', 'record-tools']
  const nodes = Object.fromEntries(ids.map(id => [id, new Element()]))
  nodes['settings-panel'].hidden = true
  const frame = new Element(); frame.hidden = true
  const messages = []; frame.contentWindow = { postMessage: (...args) => messages.push(args) }
  const names = ['login', 'reconnect', 'cancel-login', 'select-account', 'add-account', 'logout', 'usage', 'recover-legacy', 'exit']
  const buttons = names.map(name => { const node = nodes[name === 'login' ? 'primary-login' : name === 'cancel-login' ? 'cancel-login' : name === 'reconnect' ? 'primary-reconnect' : name] || new Element(); node.dataset.action = name; return node })
  const doc = { ...events(), querySelector: query => query === 'iframe' ? frame : nodes[query.slice(1)], querySelectorAll: () => buttons, createElement: () => new Element() }
  const win = events(), calls = []
  const f = { nodes, frame, messages, doc, win, calls, status, confirm: true }
  const options = { document: doc, window: win, location: { origin: 'http://127.0.0.1:12345', hash: '#fixture-capability' }, history: { replaceState() {} },
    setInterval: fn => { f.poll = fn; return 1 }, clearInterval: () => { f.cleared = true }, confirm: () => f.confirm,
    fetch: async (url, init) => {
      calls.push({ url, init })
      if (url === '/launcher/claim') return Response.json({ ok: true })
      if (url === '/launcher/status') { if (f.nextStatus) { const next = f.nextStatus; f.nextStatus = undefined; return next } return Response.json(f.status) }
      if (url === '/launcher/logout') f.status = { phase: 'login-required', accounts: [account], revocation: 'confirmed' }
      else if (url === '/launcher/login') f.status = { phase: 'logging-in', accounts: [account] }
      else if (url === '/launcher/select-account') f.status = { ...ready(), activeAccount: { ...account, id: 'fixture-b' } }
      return Response.json({ ok: true })
    } }
  f.controller = await startPortal(options)
  f.action = name => buttons.find(button => button.dataset.action === name).onclick()
  t.after(() => f.controller.dispose())
  return f
}

test('8F UX: authenticated startup automatically loads the debate once; settings never reload or close it', async t => {
  const f = await fixture(t)
  assert.deepEqual(f.frame.sources, ['/app']); assert.equal(f.frame.hidden, false)
  assert.equal(f.nodes['connection-view'].hidden, true); assert.equal(f.nodes['settings-panel'].hidden, true)
  assert.equal(f.nodes.status.textContent, 'ChatGPT 연결됨'); assert.equal(f.nodes.status.textContent.includes(account.email), false)
  assert.ok(f.nodes['account-info'].textContent.includes(account.email))
  await f.poll(); await f.poll()
  f.nodes['settings-toggle'].onclick(); assert.equal(f.nodes['settings-panel'].hidden, false)
  f.nodes['settings-close'].onclick(); f.doc.emit('keydown', { key: 'Escape' })
  assert.deepEqual(f.frame.sources, ['/app']); assert.equal(f.calls.some(call => call.url.endsWith('/exit')), false)
  assert.equal(f.calls.some(call => call.url.startsWith('/api/')), false)
})
test('8F UX: first sign-in and reauthentication return to debate automatically; expiry removes the old frame', async t => {
  const f = await fixture(t, { phase: 'login-required', accounts: [] })
  assert.equal(f.nodes['primary-login'].hidden, false); assert.equal(f.frame.hidden, true)
  await f.action('login'); assert.equal(f.nodes['cancel-login'].hidden, false)
  f.status = ready(); await f.poll(); assert.deepEqual(f.frame.sources, ['/app'])
  f.status = { ...ready(), phase: 'login-required', error: 'CHATGPT_LOGIN_REQUIRED' }; await f.poll()
  assert.equal(f.frame.src, 'about:blank'); assert.equal(f.frame.hidden, true); assert.equal(f.nodes['primary-login'].hidden, false)
  await f.action('login'); f.status = ready(); await f.poll(); await f.poll()
  assert.deepEqual(f.frame.sources, ['/app', 'about:blank', '/app'])
})
test('8F UX: a stale ready poll cannot reopen records after logout; rapid actions send one request', async t => {
  const f = await fixture(t)
  let finish
  f.nextStatus = new Promise(resolve => { finish = resolve })
  const polling = f.controller.update()
  const one = f.action('logout'), two = f.action('logout')
  await Promise.all([one, two]); finish(Response.json(ready())); await polling
  assert.equal(f.frame.hidden, true); assert.equal(f.frame.src, 'about:blank')
  assert.equal(f.calls.filter(call => call.url === '/launcher/logout').length, 1)
  await f.poll(); assert.equal(f.nodes['primary-login'].hidden, false)
  assert.equal(f.frame.sources.filter(src => src === '/app').length, 1)
})
test('8F UX: cancellation leaves the live frame intact; same selected account does not reconnect', async t => {
  const f = await fixture(t); f.confirm = false
  await f.action('logout'); await f.action('select-account')
  assert.deepEqual(f.frame.sources, ['/app']); assert.equal(f.calls.some(call => call.url === '/launcher/logout'), false)
  assert.equal(f.calls.some(call => call.url === '/launcher/select-account'), false)
})
test('8F UX: account switch clears old frame before request and reloads only after ready; teardown ignores late status', async t => {
  const f = await fixture(t)
  f.nodes.accounts.value = 'fixture-b'; await f.action('select-account')
  assert.deepEqual(f.frame.sources, ['/app', 'about:blank', '/app'])
  let finish; f.nextStatus = new Promise(resolve => { finish = resolve })
  const polling = f.controller.update(); f.controller.dispose(); finish(Response.json({ phase: 'login-required', accounts: [] })); await polling
  assert.equal(f.cleared, true); assert.equal(f.frame.hidden, false)
})
test('8F UX: record tools reuse the existing view, with same-origin/source checks and active debate protection', async t => {
  const f = await fixture(t)
  f.nodes['record-tools'].onclick()
  assert.deepEqual(f.messages, [[{ type: 'humanities-debate:open-record-tools' }, 'http://127.0.0.1:12345']])
  assert.deepEqual(f.frame.sources, ['/app'])
  const replies = [], parent = { postMessage: (...args) => replies.push(args) }
  const target = { ...events(), parent, location: { origin: 'http://127.0.0.1:12345' } }
  let idle = false, opened = 0
  const detach = attachRecordTools(target, () => idle, () => opened++)
  const event = { source: parent, origin: target.location.origin, data: { type: 'humanities-debate:open-record-tools' } }
  target.emit('message', { ...event, origin: 'https://attacker.invalid' }); target.emit('message', { ...event, source: {} }); assert.equal(replies.length, 0)
  target.emit('message', event); assert.equal(opened, 0); assert.equal(replies.length, 1)
  idle = true; target.emit('message', event); assert.equal(opened, 1)
  detach(); target.emit('message', event); assert.equal(opened, 1)
})
test('8F UX: no open-screen button remains; account actions are inside the hidden settings panel', async () => {
  const html = await readFile('desktop/chrome-siwc/portal.html', 'utf8')
  assert.doesNotMatch(html, /id="open"|토론 화면 열기/)
  const settings = html.match(/<aside[^>]*id="settings-panel"[^>]*hidden[\s\S]*?<\/aside>/)?.[0]
  for (const name of ['select-account', 'add-account', 'logout', 'usage', 'reconnect', 'recover-legacy']) assert.ok(settings.includes(`data-action="${name}"`))
})
