import assert from 'node:assert/strict'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import { listPackage, extractFile, getRawHeader, statFile } from '@electron/asar'
import { getCurrentFuseWire } from '@electron/fuses'
import { inspectReleaseText, privateReleasePath } from './release-policy.mjs'

const require = createRequire(import.meta.url)
const { NtExecutable, NtExecutableResource } = require('resedit')
if (process.argv.slice(2).some(arg => arg !== '--v1')) throw new Error('INVALID_VERIFY_ARGUMENT')
const stable = process.argv.includes('--v1'), version = stable ? '1.0.0' : '0.0.11-rc.1'
const directory = path.resolve(stable ? 'release/v1.0.0' : 'release-candidate'), unpacked = path.join(directory, 'win-unpacked')
const exe = path.join(unpacked, 'HumanitiesDebateSIWCSpeech.exe'), archive = path.join(unpacked, 'resources/app.asar')
const config = JSON.parse(extractFile(archive, 'package.json').toString())
assert.equal(config.version, version)
assert.equal(config.main, 'desktop/chrome-siwc-main.mjs')
assert.equal(config.desktopAppId, 'org.humanities.debate')
const fuses = await getCurrentFuseWire(exe)
for (const slot of [0, 2, 3, 7]) assert.equal(fuses[slot], 0x30, 'Unsafe executable fuse')
for (const slot of [4, 5]) assert.equal(fuses[slot], 0x31, 'Missing executable integrity fuse')
const pe = NtExecutableResource.from(NtExecutable.from(await readFile(exe)))
const integrityResource = pe.entries.find(entry => String(entry.type).toUpperCase() === 'INTEGRITY' && String(entry.id).toUpperCase() === 'ELECTRONASAR')
assert.ok(integrityResource, 'Missing Windows PE integrity resource')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const headerHash = sha256(Buffer.from(getRawHeader(archive).headerString))
assert.ok(JSON.parse(Buffer.from(integrityResource.bin).toString()).some(entry => entry.file.toLowerCase() === 'resources\\app.asar' && entry.alg.toLowerCase() === 'sha256' && entry.value === headerHash))
const privateLabels = []
for (const args of [['config', '--get', 'remote.origin.url'], ['log', '-1', '--format=%ae']]) {
  let value
  try { value = execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() }
  catch { continue } // A clean source ZIP has no private development .git history.
  const owner = /github\.com[:/]([^/]+)\//.exec(value)?.[1]
  if (owner) privateLabels.push(owner)
  else if (value.includes('@') && !value.endsWith('@users.noreply.github.com')) privateLabels.push(value)
}
const entries = listPackage(archive).map(name => name.replaceAll('\\', '/').replace(/^\//, ''))
let textFiles = 0, integrityFiles = 0
const inspect = (name, bytes) => {
  if (!/\.(mjs|js|cjs|json|html|css|txt|md)$/.test(name)) return
  assert.deepEqual(inspectReleaseText(bytes.toString('utf8'), privateLabels), [], 'Sensitive content candidate in package; values withheld')
  textFiles++
}
for (const name of entries) {
  assert.ok(!privateReleasePath(name) && !/whisper|codex-sdk|node_modules\//i.test(name), 'Unexpected packaged content')
  const info = statFile(archive, path.normalize(name))
  if ('files' in info) continue
  assert.ok(!('link' in info) && !info.unpacked, 'Unexpected ASAR link or unpacked code')
  const bytes = extractFile(archive, path.normalize(name))
  assert.equal(info.integrity?.hash, sha256(bytes), 'ASAR file integrity mismatch')
  if (stable && name !== 'package.json') assert.equal(sha256(bytes), sha256(await readFile(name)), 'Packaged file differs from the latest build')
  integrityFiles++
  inspect(name, bytes)
}
async function scanResources(relative = '') {
  for (const entry of await readdir(path.join(unpacked, 'resources', relative), { withFileTypes: true })) {
    const name = path.posix.join(relative, entry.name)
    assert.ok(!privateReleasePath(name) && !entry.isSymbolicLink())
    if (entry.isDirectory()) await scanResources(name)
    else inspect(name, await readFile(path.join(unpacked, 'resources', name)))
  }
}
await scanResources()
assert.match(extractFile(archive, path.normalize('desktop-dist/siwc/sdk.mjs')).toString(), /Modified DevKit bundle/)
for (const name of ['DEVKIT_LICENSE.txt', 'SIWC_ADAPTER_NOTICE.txt', 'THIRD_PARTY_react.txt', 'THIRD_PARTY_react-dom.txt', 'THIRD_PARTY_scheduler.txt']) await stat(path.join(unpacked, 'resources/licenses', name))
if (stable) {
  for (const name of ['APP_MIT_LICENSE.txt', 'LICENSE_SCOPE.md', 'NOTICE.md']) await stat(path.join(unpacked, 'resources/licenses', name))
  assert.equal(await readFile(path.join(unpacked, 'resources/licenses/APP_MIT_LICENSE.txt'), 'utf8'), await readFile('LICENSE', 'utf8'))
  assert.equal(sha256(await readFile(path.join(unpacked, 'resources/licenses/DEVKIT_LICENSE.txt'))), 'd12fe9f3c01626a133398d70e672b5591c38b1819f3da852b1e3ef8da606facd')
  assert.match(await readFile(path.join(unpacked, 'resources/licenses/SIWC_ADAPTER_NOTICE.txt'), 'utf8'), /retain.*DevKit Noncommercial License/)
  // electron-builder renames Electron's original LICENSE during packaging.
  assert.equal(sha256(await readFile(path.join(unpacked, 'LICENSE.electron.txt'))), sha256(await readFile('node_modules/electron/LICENSE')))
  await stat(path.join(unpacked, 'LICENSES.chromium.html'))
  const bundledRuntime = extractFile(archive, path.normalize('desktop-dist/siwc/runtime.mjs')).toString()
  assert.ok(bundledRuntime.includes('answeredObjectionIds'), 'Missing accepted-contribution logic')
  assert.ok(bundledRuntime.includes('var feedbackRubric'), 'Missing feedback rubric')
}
const filename = `HumanitiesDebate-Setup-${config.version}-x64.exe`, installer = path.join(directory, filename)
const sevenZip = await require('app-builder-lib/out/toolsets/7zip.js').getPath7za()
const readEmbedded = name => {
  const result = spawnSync(sevenZip, ['e', '-so', installer, name], { windowsHide: true, maxBuffer: 256_000_000, timeout: 30000 })
  assert.equal(result.status, 0, 'Cannot inspect installer contents')
  return result.stdout
}
assert.equal(sha256(readEmbedded('resources\\app.asar')), sha256(await readFile(archive)))
assert.equal(sha256(readEmbedded('HumanitiesDebateSIWCSpeech.exe')), sha256(await readFile(exe)))
const oldInstaller = 'release-siwc-speech/HumanitiesDebateSIWC-Internal-0.0.10-x64.exe'
let previous0010Preserved = null
try {
  const oldBytes = await readFile(oldInstaller)
  assert.equal(sha256(oldBytes), '78e1aad2f871e8cd40cfb6fcb6f5a459d3956229c3008557574b0160fd1c929e')
  previous0010Preserved = true
} catch (error) { if (error.code !== 'ENOENT') throw error } // Reproduction does not require an unpublished old EXE.
const bytes = await readFile(installer)
let previousRCPreserved = null
if (stable) {
  try {
    assert.equal(sha256(await readFile('release-candidate/HumanitiesDebate-Setup-0.0.11-rc.1-x64.exe')), '7766fbe23f030d10b88eb3df0ac807445a65e0b8471cf9618ffab3ebc86f02b6')
    previousRCPreserved = true
  } catch (error) { if (error.code !== 'ENOENT') throw error }
}
const projectMetadata = JSON.parse(await readFile('package.json', 'utf8'))
assert.equal(projectMetadata.devDependencies.electron, '45.3.2')
const report = { schemaVersion: 1, version: config.version, filename, sizeBytes: bytes.length, sha256: sha256(bytes),
  installerIdentity: config.desktopAppId,
  sourceVersionConfig: stable ? 'electron-builder.v1.json' : 'electron-builder.release-candidate.json', projectPackageVersion: projectMetadata.version, electronVersion: projectMetadata.devDependencies.electron,
  fuses: { runAsNode: false, nodeOptions: false, cliInspect: false, embeddedAsarIntegrity: true, onlyLoadAsar: true, fileProtocolExtraPrivileges: false },
  windowsIntegrityResourceMatches: true, asarFilesIntegrityChecked: integrityFiles, textFilesScanned: textFiles,
  credentialOrPrivateIdentityFindings: 0, privateIdentityReferenceAvailable: privateLabels.length > 0, installerEmbeddedFilesMatch: true, previous0010Preserved,
  previousRCPreserved,
  licenseDecisionPending: !stable, appLicense: stable ? 'MIT with explicit DevKit/third-party exclusions' : null,
  publicReleaseApproved: false, releaseUrl: null, downloadUrl: null, downloadCount: null, uniqueUsers: null }
await writeFile(path.join(directory, 'release-manifest.json'), JSON.stringify(report, null, 2))
await writeFile(path.join(directory, 'SHA256SUMS.txt'), `${report.sha256}  ${filename}\n`)
console.log(JSON.stringify(report, null, 2))
