import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { wavFromPCM } from '../desktop/whisper.mjs'
const root = path.resolve('.codex-debate/whisper-benchmark')
await mkdir(root, { recursive: true })
const wav = await readFile('.codex-debate/korean-long.wav')
let pcm
for (let i = 12; i + 8 <= wav.length;) {
  const n = wav.readUInt32LE(i + 4)
  if (wav.toString('ascii', i, i + 4) === 'data') { pcm = wav.subarray(i + 8, i + 8 + n); break }
  i += 8 + n + n % 2
}
if (!pcm) throw new Error('Missing synthetic PCM')
const results = []
for (const seconds of [1, 2, 3, 6, 12]) for (const fast of [false, true]) {
  const audio = path.join(root, 'input.wav'), output = path.join(root, 'output')
  await writeFile(audio, wavFromPCM(pcm.subarray(0, seconds * 32000)))
  const run = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/benchmark-whisper.ps1'),
    '-Assets', path.resolve('desktop-assets/whisper'), '-Audio', audio, '-Output', output, ...(fast ? ['-Fast'] : [])], { windowsHide: true, encoding: 'utf8', timeout: 60000 })
  if (run.status !== 0) throw new Error('Benchmark process failed')
  const text = (await readFile(output + '.txt', 'utf8')).trim()
  const metrics = JSON.parse(run.stdout)
  const item = { seconds, fast, ...metrics, cpuPercentMachine: Math.round(metrics.sampledCpuMs / metrics.wallMs / metrics.logicalCPUs * 100), characters: text.length, hasEndMarker: /\(끝\)\s*$/.test(text) }
  results.push(item); console.log(JSON.stringify(item))
  await rm(audio); await rm(output + '.txt')
}
await writeFile(path.join(root, 'report.json'), JSON.stringify({ synthetic: true, results }, null, 2))
