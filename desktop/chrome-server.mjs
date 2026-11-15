// Experimental Chrome gateway. No OAuth credentials are sent to the browser.
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { apiAllowed } from './security.mjs'

export function createChromeServer({ dist, portal, getBackend, getStatus, action, secret, extraActions = [], allowApp = () => true }) {
  const capability = randomBytes(32).toString('hex')
  const cookie = randomBytes(32).toString('hex')
  let claimed = false
  const server = createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address()?.port}`
    const reply = (status, data) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data))
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'none'")
    if (req.headers.host !== new URL(origin).host ||
      (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') return reply(403, { error: 'FORBIDDEN' })
    let url
    try { url = new URL(req.url, origin) } catch { return reply(400, { error: 'INVALID_REQUEST' }) }
    if (url.origin !== origin || url.username || url.password) return reply(403, { error: 'FORBIDDEN' })
    if (url.search) return reply(404, { error: 'NOT_FOUND' })
    if (req.method === 'POST' && url.pathname === '/launcher/claim') {
      if (claimed || req.headers['x-launch-capability'] !== capability) return reply(403, { error: 'FORBIDDEN' })
      claimed = true
      res.setHeader('Set-Cookie', `debate-launch=${cookie}; HttpOnly; SameSite=Strict; Path=/`)
      return reply(200, { ok: true })
    }
    const authorized = (req.headers.cookie || '').split(';').some(value => value.trim() === `debate-launch=${cookie}`)
    const publicAsset = ['/', '/portal.js', '/portal.css'].includes(url.pathname)
    if (!authorized && !publicAsset) return reply(403, { error: 'FORBIDDEN' })
    try {
      if (url.pathname.startsWith('/launcher/')) {
        if (req.headers['x-launch-client'] !== 'local-ui') return reply(403, { error: 'FORBIDDEN' })
        if (req.method === 'GET' && url.pathname === '/launcher/status') return reply(200, getStatus())
        const name = url.pathname.slice('/launcher/'.length)
        if (req.method !== 'POST' || !['login', 'cancel-login', 'reconnect', 'logout', 'exit', ...extraActions].includes(name)) return reply(404, { error: 'NOT_FOUND' })
        let body
        if (extraActions.includes(name)) {
          if (req.headers['content-type'] !== 'application/json') return reply(400, { error: 'INVALID_REQUEST' })
          const parts = []; let length = 0
          for await (const part of req) { length += part.length; if (length > 4096) return reply(413, { error: 'INVALID_REQUEST' }); parts.push(part) }
          try { body = JSON.parse(Buffer.concat(parts).toString('utf8')) } catch { return reply(400, { error: 'INVALID_REQUEST' }) }
        }
        const result = await action(name, body)
        return reply(200, result ?? { ok: true })
      }
      if (url.pathname.startsWith('/api/')) {
        if (!apiAllowed(req.method, url.pathname)) return reply(404, { error: 'NOT_FOUND' })
        if (req.headers['x-debate-client'] !== 'local-ui') return reply(403, { error: 'FORBIDDEN' })
        if (req.method === 'POST' && req.headers['content-type'] !== 'application/json') return reply(400, { error: 'INVALID_REQUEST' })
        const port = getBackend()
        if (!port) return reply(503, { error: 'CHATGPT_LOGIN_REQUIRED' })
        const parts = []; let size = 0
        for await (const part of req) { size += part.length; if (size > 1_000_000) return reply(413, { error: 'CONTEXT_LIMIT' }); parts.push(part) }
        const controller = new AbortController()
        res.once('close', () => { if (!res.writableEnded) controller.abort() })
        const response = await fetch(`http://127.0.0.1:${port}${url.pathname}`, { method: req.method,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(155_000)]), redirect: 'error',
          headers: { 'Content-Type': 'application/json', 'X-Debate-Client': 'local-ui', 'X-Desktop-Secret': secret,
            'X-Debate-Token': req.headers['x-debate-token'] || '' },
          ...(req.method === 'POST' ? { body: Buffer.concat(parts) } : {}) })
        res.writeHead(response.status, { 'Content-Type': 'application/json' }).end(Buffer.from(await response.arrayBuffer()))
        return
      }
      if (req.method !== 'GET') return reply(405, { error: 'INVALID_REQUEST' })
      // Explicit routes: never expose project files, auth directories or source maps.
      let file
      if (publicAsset) file = path.join(portal, url.pathname === '/' ? 'portal.html' : url.pathname.slice(1))
      else if (url.pathname === '/app' && allowApp()) file = path.join(dist, 'index.html')
      else if (/^\/assets\/[a-zA-Z0-9_.-]+\.(js|css|svg|png|woff2)$/.test(url.pathname)) file = path.join(dist, url.pathname.slice(1))
      else return reply(404, { error: 'NOT_FOUND' })
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }[path.extname(file)]
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }).end(await readFile(file))
    } catch { if (!res.headersSent) reply(503, { error: 'LOCAL_SERVICE_ERROR' }); else res.destroy() }
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  return { server, capability }
}
