// Reproduction probe using existing synthetic audio. No human recordings/transcript logs.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { createWhisperService } from '../desktop/whisper.mjs'
const root = path.resolve('.codex-debate/end-marker-probe')
await mkdir(root, { recursive: true })
const wav = await readFile('.codex-debate/korean-1.wav')
let pcm
for (let i = 12; i + 8 <= wav.length;) {
  const n = wav.readUInt32LE(i + 4)
  if (wav.toString('ascii', i, i + 4) === 'data') { pcm = wav.subarray(i + 8, i + 8 + n); break }
  i += 8 + n + n % 2
}
if (!pcm) throw new Error('Missing fixture')
const service = createWhisperService({ assets: path.resolve('desktop-assets/whisper'), dataRoot: root })
const results = []
try {
  for (const silence of [0, 5, 15]) {
    const result = await service.transcribe('probe-' + silence, Buffer.concat([pcm, Buffer.alloc(silence * 32000)]))
    results.push({ silenceSeconds: silence, ok: result.ok, characters: result.ok ? result.text.length : 0,
      hasEndMarker: result.ok && /\(끝\)\s*$/.test(result.text) })
  }
} finally { await service.close() }
await writeFile(path.join(root, 'report.json'), JSON.stringify({ synthetic: true, results }, null, 2))
console.log(JSON.stringify(results))
