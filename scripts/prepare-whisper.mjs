// Build-time download only. The installed application never downloads or uploads audio.
import { mkdir, readFile, writeFile, rename, copyFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
const root = path.resolve('desktop-assets/whisper')
await mkdir(root, { recursive: true })
const digest = data => createHash('sha256').update(data).digest('hex')
async function obtain(url, file, sha) {
  try { if (digest(await readFile(file)) === sha) return } catch { /* Download missing asset. */ }
  console.log('공식 Whisper 구성 파일 다운로드:', path.basename(file))
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) })
  if (!response.ok) throw new Error('Download failed: ' + response.status)
  const data = Buffer.from(await response.arrayBuffer())
  if (digest(data) !== sha) throw new Error('Whisper SHA-256 mismatch')
  await writeFile(file + '.part', data)
  await rename(file + '.part', file)
}
const cache = path.resolve('.codex-debate/whisper-build')
await mkdir(cache, { recursive: true })
const zip = path.join(cache, 'engine.zip')
await obtain('https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip', zip,
  '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb')
const unpack = path.join(cache, 'unpacked')
// Fixed paths supplied as environment data, never interpolated into PowerShell code.
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  'Expand-Archive -LiteralPath $env:WHISPER_BUILD_ZIP -DestinationPath $env:WHISPER_BUILD_OUT -Force'],
{ windowsHide: true, env: { ...process.env, WHISPER_BUILD_ZIP: zip, WHISPER_BUILD_OUT: unpack }, stdio: 'pipe' })
for (const file of await readdir(path.join(unpack, 'Release'))) {
  if (file === 'whisper-cli.exe' || file === 'whisper.dll' || /^ggml.*\.dll$/.test(file)) {
    await copyFile(path.join(unpack, 'Release', file), path.join(root, file))
  }
}
await obtain('https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin',
  path.join(root, 'ggml-base.bin'), '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe')
await obtain('https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin',
  path.join(root, 'ggml-silero-v6.2.0.bin'), '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987')
// Official Microsoft redistributable: installer runs it only when the required runtime is absent.
await obtain('https://download.visualstudio.microsoft.com/download/pr/990c720a-46ce-4dc7-87b9-c2eb615d34b9/CC0FF0EB1DC3F5188AE6300FAEF32BF5BEEBA4BDD6E8E445A9184072096B713B/VC_redist.x64.exe',
  path.join(root, 'vc_redist.x64.exe'), 'cc0ff0eb1dc3f5188ae6300faef32bf5beeba4bdd6e8e445a9184072096b713b')
for (const [name, url] of [
  ['WHISPER-CPP-LICENSE.txt', 'https://raw.githubusercontent.com/ggml-org/whisper.cpp/b5454/LICENSE'],
  ['WHISPER-MODEL-LICENSE.txt', 'https://raw.githubusercontent.com/openai/whisper/v20250625/LICENSE'],
  ['SILERO-VAD-LICENSE.txt', 'https://raw.githubusercontent.com/snakers4/silero-vad/master/LICENSE'],
]) {
  const response = await fetch(url)
  if (!response.ok) throw new Error('License download failed')
  await writeFile(path.join(root, name), await response.text())
}
const files = {}
for (const name of await readdir(root)) if (!name.endsWith('.part') && name !== 'manifest.json') files[name] = digest(await readFile(path.join(root, name)))
await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ engine: 'b5454', model: 'base multilingual', modelBytes: 147951465, vad: 'silero-v6.2.0', vadBytes: 885098, files }, null, 2))
console.log('로컬 한국어 인식 준비 완료: base 다국어 147,951,465 bytes / CPU / MIT')
