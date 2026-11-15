// Local fixture transport: no real ChatGPT requests, credentials or personal files.
import { createServer } from 'node:http'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { Codex } from '@openai/codex-sdk'
import { safeConfig, childEnvironment } from './codex-smoke-policy.mjs'

const root = process.cwd(), parent = path.join(root, '.codex-debate/8c-security')
await mkdir(parent, { recursive: true })
const directory = await mkdtemp(path.join(parent, 'tool-surface-'))
const home = path.join(directory, 'home'), work = path.join(directory, 'empty-work'), temp = path.join(directory, 'temp')
await Promise.all([home, work, temp].map(file => mkdir(file)))
const binary = path.join(root, 'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe')
const report = { success: false, transport: 'loopback fixture; no real model or credentials', tools: [], models: [], requests: 0, realModelTested: false }
const server = createServer(async (req, res) => {
  const parts = []
  for await (const part of req) parts.push(part)
  try {
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'))
    report.requests++
    const names = []
    const visit = items => { for (const item of items || []) { if (item.name) names.push(item.name); if (item.tools) visit(item.tools) } }
    visit(body.tools)
    report.tools = [...new Set([...report.tools, ...names])]
    report.models.push({ model: body.model, tools: [...new Set(names)] })
    const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(event('response.created', { response: { id: 'resp_fixture' } }) +
      event('response.output_item.done', { output_index: 0, item: { type: 'message', id: 'message_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Local fixture completed.' }] } }) +
      event('response.completed', { response: { id: 'resp_fixture', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }))
  } catch { res.writeHead(500).end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const config = safeConfig(home)
config.model_provider = 'local_fixture'
config.model_providers = { local_fixture: { name: 'Local verification fixture', base_url: `http://127.0.0.1:${server.address().port}/v1`, wire_api: 'responses', requires_openai_auth: false } }
// Same feature policy as production; only replace authenticated upstream transport.
try {
  const version = spawnSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true })
  report.cli = version.stdout?.trim()
  const codex = new Codex({ codexPathOverride: binary, env: childEnvironment(process.env, home, temp), config })
  for (const model of ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra']) {
    const thread = codex.startThread({ model, modelReasoningEffort: 'medium', workingDirectory: work,
      skipGitRepoCheck: true, sandboxMode: 'read-only', approvalPolicy: 'never', webSearchMode: 'disabled', networkAccessEnabled: false })
    await thread.run('Reply with the words local verification only. Do not use tools.', { signal: AbortSignal.timeout(30000) })
  }
  const dangerous = /exec|shell|read|file|patch|image|browser|computer|mcp|search|agent/i
  report.dangerousTools = report.tools.filter(name => dangerous.test(name))
  report.success = report.requests > 0 && report.dangerousTools.length === 0
  if (!report.success) process.exitCode = 1
} catch { report.error = 'TOOL_SURFACE_CHECK_FAILED'; process.exitCode = 1 }
finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  await writeFile(path.join(parent, 'tool-surface.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
