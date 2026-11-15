import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

test('v1 packaging preserves RC identity/data but separates output and requires explicit publication', async () => {
  const json = async file => JSON.parse(await readFile(file, 'utf8'))
  const config = await json('electron-builder.v1.json'), rc = await json('electron-builder.release-candidate.json')
  const metadata = await json('package.json'), lock = await json('package-lock.json')
  assert.equal(rc.extraMetadata.version, '0.0.11-rc.1')
  assert.equal(config.extraMetadata.version, '1.0.0')
  assert.equal(metadata.version, config.extraMetadata.version)
  assert.equal(lock.packages[''].version, metadata.version)
  assert.equal(config.extends, './electron-builder.release-candidate.json')
  assert.notEqual(config.directories.output, rc.directories.output)
  assert.equal(config.extraMetadata.desktopAppId, rc.appId)
  assert.equal(config.nsis.deleteAppDataOnUninstall, false)
  assert.equal(config.publish, null)
  assert.match(metadata.scripts['release:v1'], /--publish never/)
})

test('MIT scope excludes modified DevKit modules and original noncommercial license is preserved byte-for-byte', async () => {
  const hash = value => createHash('sha256').update(value).digest('hex')
  const pin = JSON.parse(await readFile('experiments/siwc-8e/source.json', 'utf8'))
  assert.equal(hash(await readFile('licenses/DEVKIT_LICENSE.txt')), pin.files.LICENSE)
  const scope = await readFile('LICENSE_SCOPE.md', 'utf8')
  for (const name of ['server/siwcResponses.mjs', 'server/siwcModels.mjs']) {
    assert.ok(scope.includes(name))
    assert.match(await readFile(name, 'utf8'), /SPDX-License-Identifier: LicenseRef-SIWC-DevKit-Noncommercial-1.0/)
  }
  assert.match(await readFile('LICENSE', 'utf8'), /MIT License/)
  assert.match(scope, /not an all-MIT executable/)
  assert.match(await readFile('licenses/INSTALLER_LICENSES.txt', 'utf8'), /SIGN-IN WITH CHATGPT DEVKIT NONCOMMERCIAL LICENSE/)
})
