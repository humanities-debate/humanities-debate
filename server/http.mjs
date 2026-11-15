import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { DebateError, validateRequest } from './dialogue.mjs'
import { validateModelSettings } from './modelCatalog.mjs'
import { validateFeedbackRequest } from './feedback.mjs'

const origins = new Set(['http://127.0.0.1:5173', 'http://localhost:5173'])
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(id)
function send(response, status, data) {
  if (!response.destroyed && !response.writableEnded) response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end(JSON.stringify(data))
}
async function readBody(request) {
  if (request.headers['content-type'] !== 'application/json') throw new DebateError('INVALID_REQUEST')
  const parts = []
  let length = 0
  for await (const part of request) {
    length += part.length
    if (length > 1_000_000) throw new DebateError('CONTEXT_LIMIT')
    parts.push(part)
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')) } catch { throw new DebateError('INVALID_REQUEST') }
}

// Dependency injection lets cancellation/security be tested without contacting a model.
export function createDebateServer(generate, { port = 3001, models, defaultSettings, analyze, desktopSecret } = {}) {
  const token = randomBytes(32).toString('hex') // Local CSRF capability, never a ChatGPT token.
  const seen = new Map()
  const active = new Map()
  const analyzingRecords = new Set()
  let tail = Promise.resolve()
  let stopping = false
  const server = createServer(async (request, response) => {
    const host = request.headers.host
    if (stopping || (desktopSecret && request.headers['x-desktop-secret'] !== desktopSecret) || host !== `127.0.0.1:${server.address()?.port ?? port}` ||
        (request.headers.origin && !origins.has(request.headers.origin)) ||
        request.headers['x-debate-client'] !== 'local-ui') return send(response, 403, { error: 'FORBIDDEN' })
    // No CORS: foreign origins cannot fetch the capability or send custom headers.
    if (request.method === 'GET' && request.url === '/api/session') return send(response, 200, { token })
    if (request.method === 'GET' && request.url === '/api/models') return models?.length
      ? send(response, 200, { models, defaultSettings }) : send(response, 503, { error: 'MODELS_UNAVAILABLE' })
    if (request.headers['x-debate-token'] !== token) return send(response, 403, { error: 'FORBIDDEN' })
    if (request.method !== 'POST' || !['/api/turn', '/api/feedback', '/api/cancel'].includes(request.url)) return send(response, 404, { error: 'NOT_FOUND' })
    let controller
    let id
    let recordId
    try {
      const body = await readBody(request)
      id = body?.id
      if (!validId(id)) throw new DebateError('INVALID_REQUEST')
      for (const [key, at] of seen) if (Date.now() - at > 600_000 && !active.has(key)) seen.delete(key)
      if (request.url === '/api/cancel') {
        active.get(id)?.abort()
        if (seen.size < 2048) seen.set(id, Date.now()) // Cancel arriving before /turn also wins.
        return send(response, 200, { cancelled: true })
      }
      if (seen.has(id)) throw new DebateError('DUPLICATE')
      if (seen.size >= 2048 || active.size >= 8) throw new DebateError('BUSY')
      const feedback = request.url === '/api/feedback'
      if (feedback && !analyze) throw new DebateError('AI_UNAVAILABLE')
      const input = feedback ? validateFeedbackRequest(body.request) : validateRequest(body.request)
      if (models) input.modelSettings = validateModelSettings(input.modelSettings, models, feedback ? 'feedback' : 'debate')
      if (feedback) {
        if (analyzingRecords.has(input.record.id)) throw new DebateError('DUPLICATE')
        recordId = input.record.id
        analyzingRecords.add(recordId)
      }
      seen.set(id, Date.now())
      controller = new AbortController()
      active.set(id, controller)
      response.once('close', () => { if (!response.writableEnded) controller.abort() })
      if (response.destroyed) controller.abort()
      // Serial execution avoids concurrent refreshes of the isolated authentication cache.
      const job = tail.then(async () => {
        if (stopping || controller.signal.aborted) throw new DebateError('CANCELLED')
        const result = await (feedback ? analyze : generate)(input, controller.signal)
        if (stopping || controller.signal.aborted) throw new DebateError('CANCELLED')
        return result
      })
      tail = job.catch(() => {})
      const result = await job
      send(response, 200, { id, ...result })
    } catch (error) {
      const code = error instanceof DebateError ? error.code : 'AI_UNAVAILABLE'
      const status = { INVALID_REQUEST: 400, UNSUPPORTED_MODEL_SETTINGS: 400, CONTEXT_LIMIT: 413, DUPLICATE: 409, CANCELLED: 409, BUSY: 429 }[code] ?? 503
      send(response, status, { error: code })
    } finally { if (controller) active.delete(id); if (recordId) analyzingRecords.delete(recordId) }
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  return {
    server,
    async close() {
      stopping = true
      for (const controller of active.values()) controller.abort()
      const closed = new Promise(resolve => server.close(resolve))
      server.closeAllConnections()
      await tail
      await closed
    },
  }
}
