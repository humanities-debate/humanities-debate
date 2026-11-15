import assert from 'node:assert/strict'
import test from 'node:test'
import { childEnvironment, safeConfig, validateChatGPTCache, redact } from '../scripts/codex-smoke-policy.mjs'

test('child environment drops all API keys, custom endpoints and inherited agent settings', () => {
  const env = childEnvironment({ Path: 'safe-path', USERPROFILE: 'real-user', OPENAI_API_KEY: 'secret', CODEX_API_KEY: 'secret', OPENAI_BASE_URL: 'other', CODEX_HOME: 'original', HTTP_PROXY: 'other' }, 'isolated', 'temp')
  assert.deepEqual(env, { Path: 'safe-path', USERPROFILE: 'real-user', CODEX_HOME: 'isolated', TEMP: 'temp', TMP: 'temp', RUST_LOG: 'off' })
})
test('API-key and missing login caches fail closed', () => {
  assert.throws(() => validateChatGPTCache({ auth_mode: 'apikey', OPENAI_API_KEY: 'secret' }))
  assert.throws(() => validateChatGPTCache({ auth_mode: 'chatgpt', OPENAI_API_KEY: 'secret', tokens: { access_token: 'test' } }))
  assert.throws(() => validateChatGPTCache({ auth_mode: 'chatgpt' }))
  assert.doesNotThrow(() => validateChatGPTCache({ auth_mode: 'chatgpt', tokens: { access_token: 'test' } }))
})
test('test configuration disables command execution, hooks, plugins, skills and browser tools', () => {
  const config = safeConfig('isolated')
  assert.equal(config.forced_login_method, 'chatgpt')
  assert.equal(config.model_provider, 'openai')
  for (const feature of ['shell_tool', 'js_repl', 'hooks', 'plugins', 'apps', 'browser_use', 'computer_use', 'multi_agent_v2']) assert.equal(config.features[feature], false)
  assert.equal(config.project_doc_max_bytes, 0)
  assert.equal(config.skills.include_instructions, false)
})
test('errors redact credentials instead of leaking them to reports', () => {
  const result = redact('opaque-refresh-secret Bearer abc sk-test-secret eyJabc.def.ghi', ['opaque-refresh-secret'])
  assert.ok(!result.includes('opaque-refresh-secret'))
  assert.ok(!result.includes('abc'))
  assert.ok(!result.includes('sk-test'))
  assert.ok(!result.includes('eyJ'))
})
