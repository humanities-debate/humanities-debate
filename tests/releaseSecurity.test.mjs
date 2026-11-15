import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { inspectReleaseText, privateReleasePath } from '../scripts/release-policy.mjs'

test('release candidate hardens unused execution features without changing the legacy installer config', async () => {
  const candidate = JSON.parse(await readFile(new URL('../electron-builder.release-candidate.json', import.meta.url), 'utf8'))
  const old = JSON.parse(await readFile(new URL('../electron-builder.siwc-speech.json', import.meta.url), 'utf8'))
  assert.equal(old.extraMetadata.version, '0.0.10')
  assert.equal(candidate.extraMetadata.version, '0.0.11-rc.1')
  assert.notEqual(candidate.directories.output, old.directories.output)
  assert.notEqual(candidate.appId, old.appId)
  assert.equal(candidate.extraMetadata.desktopAppId, candidate.appId)
  assert.equal(candidate.publish, null)
  assert.equal(candidate.nsis.deleteAppDataOnUninstall, false)
  assert.equal(candidate.electronFuses.runAsNode, false)
  assert.equal(candidate.electronFuses.enableNodeOptionsEnvironmentVariable, false)
  assert.equal(candidate.electronFuses.enableNodeCliInspectArguments, false)
  assert.equal(candidate.electronFuses.enableEmbeddedAsarIntegrityValidation, true)
  assert.equal(candidate.electronFuses.onlyLoadAppFromAsar, true)
})

test('release scan reports rule names and never copies secret values into diagnostics', () => {
  const secret = 'ghp_' + 'X'.repeat(35) // Synthetic credential-shaped fixture only.
  const result = inspectReleaseText(secret)
  assert.deepEqual(result, ['githubToken'])
  assert.ok(!JSON.stringify(result).includes(secret))
  assert.deepEqual(inspectReleaseText('private-person', ['private-person']), ['privateIdentity'])
  assert.deepEqual(inspectReleaseText('MIT copyright third-party@example.invalid'), [])
  for (const value of ['official-auth/chatgpt-auth.json', '.env', 'browser/Local Storage/leveldb']) assert.equal(privateReleasePath(value), true)
  assert.equal(privateReleasePath('desktop/siwc-accounts.mjs'), false)
})
