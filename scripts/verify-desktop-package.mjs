import assert from 'node:assert/strict'
import { listPackage, extractFile } from '@electron/asar'
import { stat, writeFile } from 'node:fs/promises'
const files = listPackage('release/win-unpacked/resources/app.asar').map(name => name.replaceAll('\\', '/'))
assert.ok(files.some(name => name.endsWith('codex-sdk/dist/index.js')))
assert.ok(files.some(name => name.endsWith('desktop-dist/runtime.mjs')))
const runtime = extractFile('release/win-unpacked/resources/app.asar', 'desktop-dist/runtime.mjs').toString('utf8')
assert.ok(runtime.includes('previousPositionIds') && runtime.includes('aiTurnsSinceUser'), 'Updated dialogue context must be in the packaged SDK runtime')
assert.ok(files.some(name => name.endsWith('desktop-dist/worker.mjs')))
assert.ok(!files.some(name => /auth\.json|\.codex-debate|\.env|[\\/]tests[\\/]|[\\/]sessions[\\/]/.test(name)))
assert.ok(!files.some(name => /node_modules[\\/](vite|typescript|electron-builder)[\\/]/.test(name)))
const binary = await stat('release/win-unpacked/resources/codex/bin/codex.exe')
assert.ok(binary.size > 1_000_000)
assert.ok(files.some(name => name.endsWith('desktop/whisper.mjs')))
assert.ok(files.some(name => name.endsWith('desktop/whisperOptions.mjs')))
assert.equal((await stat('release/win-unpacked/resources/whisper/ggml-silero-v6.2.0.bin')).size, 885098)
assert.ok((await stat('release/win-unpacked/resources/whisper/SILERO-VAD-LICENSE.txt')).size > 500)
assert.equal((await stat('release/win-unpacked/resources/whisper/ggml-base.bin')).size, 147951465)
assert.ok((await stat('release/win-unpacked/resources/whisper/whisper-cli.exe')).size > 100000)
assert.ok((await stat('release/win-unpacked/resources/whisper/vc_redist.x64.exe')).size > 1000000)
const report = { success: true, entries: files.length, sdk: '0.166.0', nativeCliOutsideAsar: true, noCredentialsOrPersonalRecords: true, noDevelopmentServer: true }
await writeFile('.codex-debate/package-check.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report))
