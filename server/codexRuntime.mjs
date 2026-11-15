import { Codex } from '@openai/codex-sdk'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir, rename } from 'node:fs/promises'
import path from 'node:path'
import { childEnvironment, safeConfig, validateChatGPTCache, redact } from '../scripts/codex-smoke-policy.mjs'
import { DebateError, buildPrompt, replySchema, validateReply, debateRoleInstruction } from './dialogue.mjs'
import { discoverModels, defaultModelSettings, validateModelSettings } from './modelCatalog.mjs'
import { buildFeedbackPrompt, feedbackSchema, feedbackRoleInstruction, validateFeedbackReply } from './feedback.mjs'
import { createStanceApproval, StanceError } from './stanceApproval.mjs'

const require = createRequire(import.meta.url)
export async function createCodexRuntime(root, options = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new DebateError('WINDOWS_X64_REQUIRED')
  const sourceHome = options.sourceHome || process.env.CODEX_HOME || path.join(homedir(), '.codex')
  const parent = path.resolve(root, '.codex-debate')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(path.join(parent, 'run-'))
  const originalCwd = process.cwd()
  const originalTemp = { TEMP: process.env.TEMP, TMP: process.env.TMP }
  let ready = false
  async function cleanup() {
    process.chdir(originalCwd)
    for (const [key, value] of Object.entries(originalTemp)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    // Desktop owns this auth home. Preserve officially refreshed credentials on clean exit.
    // Never write back to the developer's shared Codex login by default.
    let persistError
    if (ready && options.persistAuth) {
      try {
        const updated = await readFile(path.join(directory, 'home', 'auth.json'), 'utf8')
        validateChatGPTCache(JSON.parse(updated))
        const target = path.join(sourceHome, 'auth.json.next')
        await writeFile(target, updated, { mode: 0o600 })
        await rename(target, path.join(sourceHome, 'auth.json'))
      } catch { persistError = new Error('AUTH_PERSIST_FAILED') }
    }
    // Delete only the runtime directory created above, never a computed outside path.
    if (path.dirname(path.resolve(directory)) !== parent || !path.basename(directory).startsWith('run-')) throw new Error('Invalid cleanup target')
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    if (persistError) throw persistError
  }
  try {
    const identity = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true })
    const sid = identity.stdout?.match(/S-1-5-(?:\d+-)*\d+/)?.[0]
    if (identity.status !== 0 || !sid) throw new DebateError('RUNTIME_PERMISSIONS')
    const acl = spawnSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { encoding: 'utf8', windowsHide: true })
    if (acl.status !== 0) throw new DebateError('RUNTIME_PERMISSIONS')
    const home = path.join(directory, 'home')
    const work = path.join(directory, 'empty-work')
    const temp = path.join(directory, 'temp')
    await Promise.all([home, work, temp].map(dir => mkdir(dir)))
    let cached
    let secrets
    try {
      cached = await readFile(path.join(sourceHome, 'auth.json'), 'utf8')
      const auth = JSON.parse(cached)
      validateChatGPTCache(auth)
      secrets = Object.values(auth.tokens).filter(value => typeof value === 'string')
    } catch { throw new DebateError('CHATGPT_LOGIN_REQUIRED') }
    await writeFile(path.join(home, 'auth.json'), cached, { flag: 'wx', mode: 0o600 })
    cached = undefined
    const env = childEnvironment(process.env, home, temp)
    const binary = options.binary || path.join(path.dirname(require.resolve('@openai/codex-win32-x64/package.json')), 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe')
    const version = spawnSync(binary, ['--version'], { env, cwd: work, encoding: 'utf8', windowsHide: true, timeout: 15000 })
    if (version.status !== 0 || !version.stdout.includes('0.166.0')) throw new DebateError('CLI_VERSION')
    const login = spawnSync(binary, ['login', 'status'], { env, cwd: work, encoding: 'utf8', windowsHide: true, timeout: 15000 })
    if (login.status !== 0 || !`${login.stdout}\n${login.stderr}`.includes('Logged in using ChatGPT')) throw new DebateError('CHATGPT_LOGIN_REQUIRED')
    const config = safeConfig(home)
    config.developer_instructions += '\n' + debateRoleInstruction
    const codex = new Codex({ env, codexPathOverride: binary, config })
    const feedbackConfig = safeConfig(home)
    feedbackConfig.developer_instructions += '\n' + feedbackRoleInstruction
    const feedbackCodex = new Codex({ env, codexPathOverride: binary, config: feedbackConfig })
    // SDK child cwd and schema temporary files both stay inside the isolated runtime.
    process.chdir(work)
    process.env.TEMP = temp
    process.env.TMP = temp
    const models = await discoverModels(binary, env, work, config)
    const defaultSettings = defaultModelSettings(models)
    let lastThreadId
    const stanceApproval = createStanceApproval()
    const runtime = {
      model: defaultSettings.model, models, defaultSettings, cleanup,
      listModels: async () => models,
      // Server-side diagnostic only; never expose session files or transcripts over HTTP.
      async readLastExecutionSettings() {
        if (!lastThreadId) return null
        const sessions = path.join(home, 'sessions')
        const files = await readdir(sessions, { recursive: true })
        const file = files.find(name => name.endsWith(`${lastThreadId}.jsonl`))
        if (!file) return null
        const lines = (await readFile(path.join(sessions, file), 'utf8')).split('\n')
        let context
        for (const line of lines) {
          try { const event = JSON.parse(line); if (event.type === 'turn_context') context = event.payload } catch { /* incomplete last line */ }
        }
        return context ? { model: context.model, reasoningEffort: context.effort, evidence: 'Codex turn_context' } : null
      },
      generate: (request, signal) => run(request, signal, false),
      analyze: (request, signal) => run(request, signal, true),
    }
    async function run(request, signal, analyzing) {
        signal.throwIfAborted()
        const settings = validateModelSettings(request.modelSettings, models, analyzing ? 'feedback' : 'debate')
        const local = new AbortController()
        const combined = AbortSignal.any([signal, local.signal])
        const timer = setTimeout(() => local.abort(), 120_000)
        const started = performance.now()
        try {
          // Fresh thread every turn: an interrupted or rejected answer is never context.
          const threadOptions = { model: settings.model, modelReasoningEffort: settings.reasoningEffort, workingDirectory: work,
            skipGitRepoCheck: true, sandboxMode: 'read-only', approvalPolicy: 'never',
            webSearchMode: 'disabled', networkAccessEnabled: false }
          // Only validated catalog values; never log the request, prompt, auth or raw errors.
          // These are SDK input settings, not independent provider-reported model metadata.
          console.info('[AI model] ' + JSON.stringify({ requestedModel: settings.model,
            sdkModel: threadOptions.model, reasoningEffort: threadOptions.modelReasoningEffort, preset: settings.preset ?? 'legacy-manual' }))
          const complete = async (prompt, schema) => {
            combined.throwIfAborted()
            let response = '', completed = false
            const thread = (analyzing ? feedbackCodex : codex).startThread(threadOptions)
            const { events } = await thread.runStreamed(prompt, { signal: combined, outputSchema: schema })
            for await (const event of events) {
              combined.throwIfAborted()
              if (event.type === 'turn.failed') throw new Error(event.error.message)
              if (event.type.startsWith('item.') && event.item) {
                if (event.item.type === 'error') continue
                if (!['agent_message', 'reasoning'].includes(event.item.type)) {
                  local.abort()
                  throw new DebateError('FORBIDDEN_TOOL')
                }
                if (event.type === 'item.completed' && event.item.type === 'agent_message') response = event.item.text
              }
              if (event.type === 'turn.completed') completed = true
            }
            combined.throwIfAborted()
            if (!completed) throw new DebateError('AI_UNAVAILABLE')
            if (redact(response, secrets) !== response) throw new DebateError('INVALID_REPLY')
            lastThreadId = thread.id
            return response
          }
          const check = payload => complete(payload.instructions + '\n' + payload.input, payload.outputSchema)
          if (!analyzing) request = await stanceApproval.prepare(request, check)
          const response = await complete(analyzing ? buildFeedbackPrompt(request) : buildPrompt(request), analyzing ? feedbackSchema : replySchema)
          const reply = analyzing ? validateFeedbackReply(response, request) : validateReply(response, request)
          if (!analyzing) await stanceApproval.approve(request, reply, check)
          combined.throwIfAborted()
          return { ...reply, ...settings, elapsedSeconds: Number(((performance.now() - started) / 1000).toFixed(3)) }
        } catch (error) {
          if (signal.aborted) throw new DebateError('CANCELLED')
          if (error instanceof DebateError) throw error
          if (error instanceof StanceError) throw new DebateError(error.code)
          if (local.signal.aborted) throw new DebateError('TIMEOUT')
          // Never forward SDK stderr, credentials, paths or raw service errors to the UI/log.
          const message = String(error?.message ?? '')
          if (/401|unauthorized|refresh.token|authentication|login/i.test(message)) throw new DebateError('CHATGPT_LOGIN_REQUIRED')
          if (/model.*(not supported|not available|not found|does not exist)|unsupported.*(reasoning|effort)|reasoning.*not supported/i.test(message)) throw new DebateError('UNSUPPORTED_MODEL_SETTINGS')
          if (/429|rate.limit|usage.limit|quota|model.*(access|available|supported)/i.test(message)) throw new DebateError('LIMIT')
          throw new DebateError('AI_UNAVAILABLE')
        } finally { clearTimeout(timer) }
    }
    ready = true
    return runtime
  } catch (error) {
    await cleanup()
    throw error
  }
}
