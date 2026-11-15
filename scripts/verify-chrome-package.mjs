import assert from 'node:assert/strict'
import { listPackage, extractFile } from '@electron/asar'
import { readdir, readFile, stat, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
const root = process.cwd()
const packageRoot = path.join(root, 'release-chrome/win-unpacked')
const archive = path.join(packageRoot, 'resources/app.asar')
const files = listPackage(archive).map(name => name.replaceAll('\\', '/').replace(/^\//, ''))
const unsafe = name => /(^|\/)(auth\.json(?:\.[^/]*)?|\.env(?:\.[^/]*)?|\.codex(?:-debate|-smoke)?|codex-auth|browser|Local Storage|sessions)(\/|$)/i.test(name)
assert.ok(!files.some(unsafe), 'Private files found in package')
const config = JSON.parse(extractFile(archive, 'package.json').toString())
assert.equal(config.main, 'desktop/chrome-main.mjs')
assert.ok(files.includes('desktop/chrome-profile.mjs'))
assert.ok(files.includes('desktop-dist/runtime.mjs'))
assert.ok(!files.some(name => /whisper|node_modules\/(vite|typescript|electron-builder)\//i.test(name)))
let scanned = 0
const inspectText = buffer => {
  const text = buffer.toString('utf8')
  assert.ok(!/(?:sk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})/.test(text), 'Credential-shaped literal found; do not publish')
  assert.ok(!/["'](?:access_token|refresh_token|id_token)["']\s*:\s*["'][A-Za-z0-9._-]{30,}["']/.test(text), 'Credential value found; do not publish')
  scanned++
}
for (const name of files) if (/\.(mjs|cjs|js|json|html|css|md|txt)$/.test(name)) inspectText(extractFile(archive, path.normalize(name)))
async function inspectDirectory(directory, relative = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.posix.join(relative, entry.name)
    assert.ok(!unsafe(name), 'Private resource found')
    if (entry.isSymbolicLink()) throw new Error('Unexpected resource link')
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) await inspectDirectory(file, name)
    else if (/\.(mjs|cjs|js|json|html|css|md|txt)$/.test(name)) inspectText(await readFile(file))
  }
}
await inspectDirectory(path.join(packageRoot, 'resources'))
assert.ok((await stat(path.join(packageRoot, 'resources/codex/bin/codex.exe'))).size > 1_000_000)
const installers = (await readdir(path.join(root, 'release-chrome'))).filter(name => /^HumanitiesDebateChrome-Internal-.*\.exe$/.test(name))
const installer = installers.at(-1)
assert.ok(installer, 'Build the internal installer before verifying it')
const installerPath = path.join(root, 'release-chrome', installer)
const bytes = await readFile(installerPath)
const require = createRequire(import.meta.url)
const { getPath7za } = require('app-builder-lib/out/toolsets/7zip.js')
const sevenZip = await getPath7za() // Existing electron-builder tool cache; no new library.
const listing = spawnSync(sevenZip, ['l', '-slt', installerPath], { windowsHide: true, encoding: 'utf8', maxBuffer: 4_000_000, timeout: 30000 })
assert.equal(listing.status, 0, 'Could not inspect embedded installer payload')
const members = [...listing.stdout.split('----------').slice(1).join('\n').matchAll(/^Path = (.+)\r?$/gm)].map(match => match[1].trim().replaceAll('\\', '/'))
assert.ok(members.includes('resources/app.asar'))
assert.ok(!members.some(name => unsafe(name) || name.includes('..') || /^[A-Za-z]:/.test(name)), 'Unsafe installer member')
const embedded = spawnSync(sevenZip, ['e', '-so', installerPath, 'resources\\app.asar'], { windowsHide: true, maxBuffer: 64_000_000, timeout: 30000 })
assert.equal(embedded.status, 0, 'Could not read embedded app.asar')
const hash = buffer => createHash('sha256').update(buffer).digest('hex')
assert.equal(hash(embedded.stdout), hash(await readFile(archive)), 'Installer payload differs from the inspected app')
const report = { success: true, asarEntries: files.length, textFilesScanned: scanned, noCredentialFilesOrLiterals: true,
  noUserProfilesOrRecords: true, bundledCodexCLI: true, runtimeBundled: true, installer: installer || null,
  installerBytes: bytes.length, installerSha256: hash(bytes), installerMemberCount: members.length, installerPayloadMatchesInspectedAsar: true,
  scope: 'Installer members and embedded app verified; does not prove other-account authentication', publicReleaseReady: false }
await mkdir(path.join(root, '.codex-debate'), { recursive: true })
await writeFile(path.join(root, '.codex-debate/chrome-package-check.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
