// Read-only inspection of existing login status. Never print/read tokens in reports.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromeProfilePaths } from '../desktop/chrome-profile.mjs'
import { createCodexRuntime } from '../desktop-dist/runtime.mjs'
import { childEnvironment } from './codex-smoke-policy.mjs'

const root = process.cwd()
const parent = path.join(root, '.codex-debate', 'chrome-isolation')
await mkdir(parent, { recursive: true })
const scratch = await mkdtemp(path.join(parent, 'check-'))
const binary = path.join(root, 'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe')
const report = { date: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }), success: false, profiles: {}, checks: [],
  recordsAB: { status: 'USER_CONFIRMED', source: 'User reported A/B record separation; not a different-account test' },
  differentChatGPTAccounts: 'UNVERIFIED', differentWindowsUsers: 'UNVERIFIED', remoteRevocation: 'UNVERIFIED', remoteInference: 'NOT_REQUESTED' }
const inheritedHome = process.env.CODEX_HOME
let runtime
try {
  const homes = ['A', 'B'].map(profile => chromeProfilePaths({ root, profile, packaged: false }))
  assert.notEqual(homes[0].authHome, homes[1].authHome)
  assert.notEqual(homes[0].browser, homes[1].browser)
  for (let i = 0; i < homes.length; i++) {
    const profile = ['A', 'B'][i], home = homes[i].authHome
    let exists = false
    try { await access(path.join(home, 'auth.json')); exists = true } catch { /* clean profile */ }
    let cachedChatGPTLogin = false
    if (exists) {
      const result = spawnSync(binary, ['-c', 'forced_login_method="chatgpt"', '-c', 'cli_auth_credentials_store="file"', 'login', 'status'],
        { cwd: scratch, env: childEnvironment(process.env, home, scratch), windowsHide: true, encoding: 'utf8', timeout: 15000 })
      cachedChatGPTLogin = result.status === 0 && /Logged in using ChatGPT/.test(`${result.stdout}\n${result.stderr}`)
      // CLI output is intentionally not included: it could change to contain account details.
    }
    report.profiles[profile] = { separateAuthDirectory: true, separateBrowserDirectory: true, credentialFilePresent: exists, cachedChatGPTLogin,
      provesRemoteModelAccess: false }
  }
  const fresh = path.join(scratch, 'fresh-auth')
  await mkdir(fresh)
  process.env.CODEX_HOME = homes[0].authHome
  const env = childEnvironment({ ...process.env, OPENAI_API_KEY: 'test-api-key-must-be-dropped', CODEX_HOME: homes[0].authHome }, fresh, scratch)
  assert.equal(env.CODEX_HOME, fresh)
  assert.equal(env.OPENAI_API_KEY, undefined)
  await assert.rejects(async () => { runtime = await createCodexRuntime(scratch, { sourceHome: fresh, binary }) }, error => error.code === 'CHATGPT_LOGIN_REQUIRED')
  report.checks.push('Explicit empty authentication home rejects login even with inherited CODEX_HOME pointing to signed-in A')
  report.checks.push('API keys and inherited authentication path removed from child environment')
  report.checks.push('A/B credential and browser storage directories are distinct; no credentials copied or logged out')
  report.success = true
} catch (error) { report.error = /^[A-Z_]+$/.test(error.code || '') ? error.code : 'ISOLATION_CHECK_FAILED'; process.exitCode = 1 }
finally {
  await runtime?.cleanup()
  if (inheritedHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = inheritedHome
  await writeFile(path.join(parent, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
