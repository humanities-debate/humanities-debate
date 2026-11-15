import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { QUALITY_ARGS, VAD_MODEL, VAD_BYTES } from './whisperOptions.mjs'

export const MAX_AUDIO_BYTES = 16000 * 2 * 300
export function validSpeechId(id) { return typeof id === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(id) }
export function wavFromPCM(input) {
  if (!(input instanceof Uint8Array) || !input.byteLength || input.byteLength % 2 || input.byteLength > MAX_AUDIO_BYTES) throw new Error('INVALID_AUDIO')
  const header = Buffer.alloc(44)
  header.write('RIFF'); header.writeUInt32LE(36 + input.byteLength, 4); header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(input.byteLength, 40)
  return Buffer.concat([header, input])
}
// Only fixed executable/model/arguments. No renderer paths, commands or cloud connections.
export function createWhisperService({ assets, dataRoot, spawnProcess = spawn, timeoutMs = 300000 }) {
  const tempRoot = path.resolve(dataRoot, 'speech-temp')
  let active, closed = false
  const ready = (async () => {
    await mkdir(tempRoot, { recursive: true })
    for (const entry of await readdir(tempRoot, { withFileTypes: true })) {
      if (/^audio-[a-zA-Z0-9]+$/.test(entry.name) && entry.isDirectory() && !entry.isSymbolicLink()) {
        await rm(path.join(tempRoot, entry.name), { recursive: true, force: true })
      }
    }
  })()
  void ready.catch(() => {})
  function cancel(id) {
    if (active && (!id || active.id === id)) { active.cancelled = true; active.child?.kill() }
  }
  async function transcribe(id, pcm) {
    if (!validSpeechId(id)) return { ok: false, code: 'INVALID_AUDIO' }
    if (closed) return { ok: false, code: 'CANCELLED' }
    if (active) return { ok: false, code: 'BUSY' }
    let wav
    try { wav = wavFromPCM(pcm) } catch { return { ok: false, code: 'INVALID_AUDIO' } }
    // Digital silence should not be sent to a generative transcriber.
    const samples = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    let energy = 0
    for (let i = 0; i < pcm.byteLength; i += 2) energy += samples.getInt16(i, true) ** 2
    if (Math.sqrt(energy / (pcm.byteLength / 2)) < 8) return { ok: true, text: '' }
    const job = { id, cancelled: false, child: null }
    active = job
    job.done = (async () => {
      let dir
      try {
        await ready
        if (job.cancelled) return { ok: false, code: 'CANCELLED' }
        if ((await stat(path.join(assets, 'ggml-base.bin'))).size !== 147951465) throw new Error('MODEL_MISSING')
        if ((await stat(path.join(assets, VAD_MODEL))).size !== VAD_BYTES) throw new Error('VAD_MISSING')
        dir = await mkdtemp(path.join(tempRoot, 'audio-'))
        await writeFile(path.join(dir, 'input.wav'), wav, { mode: 0o600 })
        wav = null
        if (job.cancelled) return { ok: false, code: 'CANCELLED' }
        // b5454 aborts on non-ASCII model arguments. OS cwd accepts Unicode; fixed ASCII model name avoids it.
        const args = ['-m', 'ggml-base.bin', '-f', path.join(dir, 'input.wav'),
          '-l', 'ko', '-t', '4', '-ng', '-nt', '-np', '-otxt', '-of', path.join(dir, 'result'), ...QUALITY_ARGS]
        // Captions and final recognition use normal beam/fallback settings.
        // VAD filters non-speech before decoding; no text filtering or deduplication.
        const result = await new Promise(resolve => {
          // Do not inherit API credentials or record stdout/stderr (which can contain speech).
          const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(systemroot|windir|path|temp|tmp)$/i.test(key)))
          const child = spawnProcess(path.join(assets, 'whisper-cli.exe'), args, { cwd: assets, windowsHide: true, shell: false, env, stdio: 'ignore' })
          job.child = child
          let timedOut = false
          const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
          child.once('error', () => { clearTimeout(timer); resolve('ENGINE_FAILED') })
          child.once('close', code => { clearTimeout(timer); resolve(job.cancelled ? 'CANCELLED' : timedOut ? 'TIMEOUT' : code === 0 ? null : 'ENGINE_FAILED') })
          if (job.cancelled) child.kill()
        })
        if (result) return { ok: false, code: result }
        if (job.cancelled) return { ok: false, code: 'CANCELLED' }
        const text = (await readFile(path.join(dir, 'result.txt'), 'utf8')).trim()
        if (job.cancelled) return { ok: false, code: 'CANCELLED' }
        if (text.length > 20000) return { ok: false, code: 'OUTPUT_LIMIT' }
        return { ok: true, text }
      } catch { return { ok: false, code: job.cancelled ? 'CANCELLED' : 'ENGINE_FAILED' } }
      finally {
        if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
        if (active === job) active = undefined
      }
    })()
    return job.done
  }
  return { transcribe, cancel, async close() { closed = true; cancel(); await active?.done; await ready } }
}
