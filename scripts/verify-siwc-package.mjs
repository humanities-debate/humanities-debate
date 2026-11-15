import assert from 'node:assert/strict'
import { listPackage, extractFile } from '@electron/asar'
import { readdir, readFile, stat, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

const speechFix = process.argv.includes('--speech-fix')
const output = speechFix ? 'release-siwc-speech' : 'release-siwc'
const root = process.cwd(), packageRoot = path.join(root, output, 'win-unpacked')
const archive = path.join(packageRoot, 'resources/app.asar')
const files = listPackage(archive).map(name => name.replaceAll('\\', '/').replace(/^\//, ''))
const unsafe = name => /(^|\/)(?:auth\.json(?:\.[^/]*)?|chatgpt-auth\.json(?:\.[^/]*)?|\.env(?:\.[^/]*)?|\.codex(?:-debate|-smoke)?|official-auth|codex-auth|browser|Local Storage|sessions)(\/|$)/i.test(name)
assert.ok(!files.some(unsafe), 'Private file in package')
const config = JSON.parse(extractFile(archive, 'package.json').toString())
assert.equal(config.main, 'desktop/chrome-siwc-main.mjs'); assert.equal(config.version, speechFix ? '0.0.10' : '0.0.9')
for (const name of ['desktop/siwc-accounts.mjs', 'desktop/chrome-siwc/portal.js', 'desktop/chrome-recovery/portal.js',
  'desktop-dist/siwc/sdk.mjs', 'desktop-dist/siwc/runtime.mjs', 'desktop-dist/siwc/backend.mjs', 'dist/index.html']) assert.ok(files.includes(name), `Missing ${name}`)
assert.ok(!files.some(name => /whisper|codex-sdk|desktop-dist\/(worker|runtime)\.mjs|node_modules\/(vite|typescript|electron-builder)\//i.test(name)))
let scanned = 0
function inspectText(bytes) {
  const text = bytes.toString('utf8')
  assert.ok(!/(?:sk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})/.test(text), 'Credential-shaped literal in package')
  assert.ok(!/["'](?:access_token|refresh_token|id_token)["']\s*:\s*["'][A-Za-z0-9._-]{30,}["']/.test(text), 'Credential literal in package')
  scanned++
}
for (const file of files) if (/\.(mjs|js|cjs|json|html|css|txt|md)$/.test(file)) inspectText(extractFile(archive, path.normalize(file)))
async function inspectDirectory(directory, relative = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.posix.join(relative, entry.name), file = path.join(directory, entry.name)
    assert.ok(!unsafe(name) && !entry.isSymbolicLink(), 'Unsafe resource')
    if (entry.isDirectory()) await inspectDirectory(file, name)
    else if (/\.(mjs|js|cjs|json|html|css|txt|md)$/.test(name)) inspectText(await readFile(file))
  }
}
await inspectDirectory(path.join(packageRoot, 'resources'))
await stat(path.join(packageRoot, 'resources/licenses/DEVKIT_LICENSE.txt'))
await stat(path.join(packageRoot, 'resources/licenses/SIWC_ADAPTER_NOTICE.txt'))
const installer = path.join(root, output, `HumanitiesDebateSIWC-Internal-${config.version}-x64.exe`)
const require = createRequire(import.meta.url)
const sevenZip = await require('app-builder-lib/out/toolsets/7zip.js').getPath7za()
const listing = spawnSync(sevenZip, ['l', '-slt', installer], { windowsHide: true, encoding: 'utf8', maxBuffer: 4_000_000, timeout: 30000 })
assert.equal(listing.status, 0)
const members = [...listing.stdout.split('----------').slice(1).join('\n').matchAll(/^Path = (.+)\r?$/gm)].map(item => item[1].trim().replaceAll('\\', '/'))
assert.ok(members.includes('resources/app.asar'))
assert.ok(!members.some(name => unsafe(name) || name.includes('..') || /^[A-Za-z]:/.test(name)))
const embedded = spawnSync(sevenZip, ['e', '-so', installer, 'resources\\app.asar'], { windowsHide: true, maxBuffer: 64_000_000, timeout: 30000 })
assert.equal(embedded.status, 0)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
assert.equal(hash(embedded.stdout), hash(await readFile(archive)))
const previous = path.join(root, 'release-chrome/HumanitiesDebateChrome-Internal-0.0.7-x64.exe')
assert.equal(hash(await readFile(previous)), '9d63f1280c1ac735e2e558599be87fd68c3e3c22cffaa2af95541a3cf61bf51f')
assert.equal(hash(await readFile(path.join(root, 'release-siwc/HumanitiesDebateSIWC-Internal-0.0.8-x64.exe'))), '69e1927e421e419ca3edbe80a20188c1f9741666b72286af1b702d78aaa35f8b')
assert.equal(hash(await readFile(path.join(root, 'release-siwc/HumanitiesDebateSIWC-Internal-0.0.9-x64.exe'))), 'b052e8f764ecd6d47e0e65008f6ee4bf7e2719a03b3bdcd51ad671a6ae3df505')
assert.equal((await stat(path.join(root, 'release/HumanitiesDebate-Setup-0.0.6-x64.exe'))).size, 404400053)
const installerBytes = await readFile(installer)
const report = { success: true, version: config.version, asarEntries: files.length, textFilesScanned: scanned,
  noCredentialFilesOrLiterals: true, noUserProfilesOrRecords: true, noCodexOrWhisperRuntime: true,
  installerBytes: installerBytes.length, installerSha256: hash(installerBytes), embeddedAsarMatches: true,
  previous007InstallerHashUnchanged: true, previous008InstallerHashUnchanged: true, previous009InstallerHashUnchanged: true, electronWhisperBackupPreserved: true, publicReleaseReady: false }
await mkdir(path.join(root, '.codex-debate'), { recursive: true })
await writeFile(path.join(root, '.codex-debate', speechFix ? 'siwc-speech-package-check.json' : 'siwc-8f-package-check.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
