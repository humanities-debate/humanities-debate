// Isolated NSIS registration/install folder and synthetic profile; never touches the real app registration.
import { cp, mkdir, readFile, writeFile, readdir, access, rename } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import assert from 'node:assert/strict'
import { extractFile } from '@electron/asar'
const root = process.cwd(), base = path.join(root, '.codex-debate/8c-installer-lifecycle')
const oldApp = path.join(base, 'old-app'), install = path.join(base, 'installed')
const data = path.join(base, 'profiles'), profile = 'installation-fixture'
const fixtureExe = 'InstallerFixtureApp.exe'
await mkdir(base, { recursive: true })
if (process.argv.includes('--prepare-old')) {
  await access(path.join(root, 'release-chrome/win-unpacked/resources/app.asar'))
  assert.equal(JSON.parse(extractFile(path.join(root, 'release-chrome/win-unpacked/resources/app.asar'), 'package.json').toString()).version, '0.0.6', 'Prepare the genuine 0.0.6 package before building 0.0.7')
  await cp(path.join(root, 'release-chrome/win-unpacked'), oldApp, { recursive: true, errorOnExist: true, force: false })
  console.log('Saved previous packaged app in the isolated installer test directory.')
} else {
  const require = createRequire(import.meta.url)
  const builder = require.resolve('electron-builder/out/cli/cli.js')
  const report = { success: false, checks: [], differentPC: 'UNVERIFIED', realUserDataTouched: false }
  const env = { ...process.env }; for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key]
  function run(exe, args, timeout = 180000) {
    return new Promise((resolve, reject) => {
      const child = spawn(exe, args, { cwd: root, env, windowsHide: true, stdio: 'inherit' })
      const timer = setTimeout(() => { child.kill(); reject(new Error('TEST_TIMEOUT')) }, timeout)
      child.once('error', reject)
      child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('PROCESS_FAILED')) })
    })
  }
  async function build(version, folder) {
    const staged = path.join(base, `fixture-app-${version}`)
    await cp(folder, staged, { recursive: true })
    await rename(path.join(staged, 'HumanitiesDebateChrome.exe'), path.join(staged, fixtureExe))
    const output = path.join(base, `installer-${version}`)
    const config = JSON.parse(await readFile(path.join(root, 'electron-builder.chrome.json'), 'utf8'))
    config.appId = 'local.humanities.debate.chrome.8c.installerfixture'
    config.productName = 'Debate Chrome Installer Fixture'
    config.win.executableName = 'InstallerFixtureApp'
    config.extraMetadata = { ...config.extraMetadata, version }
    config.directories = { output }
    config.nsis = { ...config.nsis, createDesktopShortcut: false, createStartMenuShortcut: false, runAfterFinish: false,
      artifactName: 'InstallerFixture-${version}-${arch}.exe' }
    const file = path.join(base, `config-${version}.json`)
    await writeFile(file, JSON.stringify(config, null, 2))
    await run(process.execPath, [builder, '--win', 'nsis', '--x64', '--prepackaged', staged, '--config', file, '--publish', 'never'], 600000)
    return path.join(output, `InstallerFixture-${version}-x64.exe`)
  }
  async function verify(expectExisting) {
    await run(process.execPath, ['scripts/verify-chrome-prototype.mjs', '--packaged', '--skip-speech',
      `--executable=${path.join(install, fixtureExe)}`, `--verification-root=${data}`, `--profile=${profile}`,
      ...(expectExisting ? ['--expect-existing-marker'] : [])])
  }
  try {
    assert.ok(install.startsWith(base + path.sep) && data.startsWith(base + path.sep))
    assert.equal(JSON.parse(extractFile(path.join(oldApp, 'resources/app.asar'), 'package.json').toString()).version, '0.0.6')
    assert.equal(JSON.parse(extractFile(path.join(root, 'release-chrome/win-unpacked/resources/app.asar'), 'package.json').toString()).version, '0.0.7')
    const older = await build('0.0.6', oldApp)
    await run(older, ['/S', `/D=${install}`])
    await access(path.join(install, fixtureExe))
    await verify(false)
    report.checks.push('Previous version installed in dedicated directory; synthetic record and feedback seeded')
    const current = await build('0.0.7', path.join(root, 'release-chrome/win-unpacked'))
    await run(current, ['/S', `/D=${install}`]); await verify(true)
    report.checks.push('0.0.6 to 0.0.7 upgrade preserves synthetic full transcript and feedback')
    await run(current, ['/S', `/D=${install}`]); await verify(true)
    report.checks.push('Same-version reinstall preserves synthetic records')
    const uninstaller = (await readdir(install)).find(name => /^Uninstall.*\.exe$/i.test(name))
    assert.ok(uninstaller)
    await run(path.join(install, uninstaller), ['/S', `_?=${install}`])
    await assert.rejects(access(path.join(install, fixtureExe)))
    await access(path.join(data, profile, 'browser'))
    await run(current, ['/S', `/D=${install}`]); await verify(true)
    report.checks.push('Uninstall removes test app and keeps isolated data; reinstall restores transcript and feedback')
    // Leave no installed test registration. Only this fixture app's uninstaller is invoked.
    const finalUninstaller = (await readdir(install)).find(name => /^Uninstall.*\.exe$/i.test(name))
    await run(path.join(install, finalUninstaller), ['/S', `_?=${install}`])
    report.success = true
  } catch (error) { report.error = error.message; process.exitCode = 1 }
  finally { await writeFile(path.join(base, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)) }
}
