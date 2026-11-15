import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { DebateError } from './dialogue.mjs'
import { parsePreset, presetMatches } from '../src/config/aiPresets.ts'

export const preferredModels = ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra']
const efforts = ['low', 'medium', 'high']

// Use returned IDs/capabilities, never infer them from a display name.
export function modelChoices(rows) {
  return rows.filter(row => row && !row.hidden && typeof row.model === 'string')
    .map(row => ({ model: row.model, displayName: row.displayName || row.model,
      reasoningEfforts: efforts.filter(effort => row.supportedReasoningEfforts?.some(item => item.reasoningEffort === effort)),
      defaultReasoningEffort: row.defaultReasoningEffort, isDefault: row.isDefault === true }))
    .filter(row => row.reasoningEfforts.length && preferredModels.includes(row.model))
    .sort((a, b) => preferredModels.indexOf(a.model) - preferredModels.indexOf(b.model))
}
export function defaultModelSettings(models) {
  const model = models.find(item => item.model === preferredModels[0]) ?? models.find(item => item.isDefault) ?? models[0]
  if (!model) throw new DebateError('MODELS_UNAVAILABLE')
  return { model: model.model, reasoningEffort: model.reasoningEfforts.includes('medium') ? 'medium' : model.reasoningEfforts[0] }
}
export function validateModelSettings(value, models, purpose) {
  const model = models.find(item => item.model === value?.model)
  if (!model || !model.reasoningEfforts.includes(value?.reasoningEffort) || !presetMatches(value, purpose)) throw new DebateError('UNSUPPORTED_MODEL_SETTINGS')
  const preset = parsePreset(value.preset, purpose)
  return { model: value.model, reasoningEffort: value.reasoningEffort, ...(preset ? { preset } : {}) }
}
function configArgs(config, prefix = '') {
  return Object.entries(config).flatMap(([key, value]) => {
    const name = prefix ? `${prefix}.${key}` : key
    return value && typeof value === 'object' && !Array.isArray(value) ? configArgs(value, name) : ['-c', `${name}=${JSON.stringify(value)}`]
  })
}

// Short-lived stdio discovery process; never starts a thread or model turn.
export async function discoverModels(binary, env, cwd, config) {
  const child = spawn(binary, [...configArgs(config), 'app-server', '--listen', 'stdio://'], { env, cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = createInterface({ input: child.stdout })
  const pending = new Map()
  let nextId = 0
  let failure
  const fail = () => {
    failure = new DebateError('MODELS_UNAVAILABLE')
    for (const { reject } of pending.values()) reject(failure)
    pending.clear()
  }
  child.stderr.resume() // Never print raw CLI diagnostics or account information.
  child.stdin.on('error', fail)
  child.on('error', fail)
  const closed = new Promise(resolve => child.once('close', () => { fail(); resolve() }))
  lines.on('line', line => {
    let event
    try { event = JSON.parse(line) } catch { return }
    const task = pending.get(event.id)
    if (!task) return
    pending.delete(event.id)
    if (event.error) task.reject(new DebateError('MODELS_UNAVAILABLE'))
    else task.resolve(event.result)
  })
  const send = event => child.stdin.write(JSON.stringify(event) + '\n')
  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return }
    const id = nextId++
    pending.set(id, { resolve, reject })
    send({ id, method, params })
  })
  const timer = setTimeout(() => { fail(); child.kill() }, 30_000)
  try {
    await rpc('initialize', { clientInfo: { name: 'skhynix_debate', title: 'Local debate practice', version: '0.0.0' } })
    send({ method: 'initialized', params: {} })
    const rows = []
    let cursor
    for (let page = 0; page < 10; page++) {
      const result = await rpc('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) })
      if (!Array.isArray(result?.data)) throw new DebateError('MODELS_UNAVAILABLE')
      rows.push(...result.data)
      cursor = result.nextCursor
      if (!cursor) return modelChoices(rows)
    }
    throw new DebateError('MODELS_UNAVAILABLE')
  } finally {
    clearTimeout(timer)
    lines.close()
    child.kill()
    await closed
  }
}
