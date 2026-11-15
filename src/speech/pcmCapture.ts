export interface PCMCapture {
  start(): Promise<void>
  stop(): Promise<Uint8Array>
  preview(startSample: number, maxSamples: number): Uint8Array
  cancel(): void
}
export const MAX_CAPTURE_SAMPLES = 16000 * 300
export function createPCMCapture(onInterrupted: () => void): PCMCapture {
  let stream: MediaStream | undefined, context: AudioContext | undefined, node: AudioWorkletNode | undefined
  let cancelled = false, stopped = false, count = 0
  let chunks: Int16Array[] = []
  let finish: (() => void) | undefined
  let limit: ReturnType<typeof setTimeout> | undefined
  const release = () => {
    clearTimeout(limit)
    stream?.getTracks().forEach(track => { track.onended = null; track.stop() })
    node?.disconnect()
    void context?.close().catch(() => {})
  }
  // Copy a bounded range without consuming or interrupting the final recording.
  function copy(startSample: number, maxSamples: number) {
    const size = Math.max(0, Math.min(count - startSample, maxSamples))
    const bytes = new Uint8Array(size * 2), view = new DataView(bytes.buffer)
    let position = 0, written = 0
    for (const chunk of chunks) {
      const from = Math.max(0, startSample - position)
      const to = Math.min(chunk.length, startSample + size - position)
      for (let i = from; i < to; i++) { view.setInt16(written * 2, chunk[i], true); written++ }
      position += chunk.length
      if (written === size) break
    }
    return bytes
  }
  return {
    preview(startSample, maxSamples) { return cancelled || stopped ? new Uint8Array() : copy(startSample, maxSamples) },
    async start() {
      try {
        context = new AudioContext({ sampleRate: 16000 })
        if (context.sampleRate !== 16000) throw new Error('SAMPLE_RATE')
        await context.audioWorklet.addModule(new URL('./pcmWorklet.js', import.meta.url).href)
        if (cancelled) { release(); return }
        node = new AudioWorkletNode(context, 'pcm-capture')
        node.port.onmessage = event => {
          if (cancelled) return
          if (event.data.pcm instanceof Int16Array) {
            const chunk = event.data.pcm.slice(0, Math.max(0, MAX_CAPTURE_SAMPLES - count))
            chunks.push(chunk); count += chunk.length
            if (count >= MAX_CAPTURE_SAMPLES && !stopped) onInterrupted()
          }
          if (event.data.ended) finish?.()
        }
        node.onprocessorerror = () => onInterrupted()
        // Prepare the processor BEFORE opening the microphone, so module loading cannot drop initial audio.
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false })
        if (cancelled) { release(); return }
        context.createMediaStreamSource(stream).connect(node)
        // Processor outputs silence. Connection keeps the audio graph running without feedback.
        node.connect(context.destination)
        stream.getAudioTracks().forEach(track => { track.onended = onInterrupted })
        await context.resume()
        if (cancelled) { release(); return }
        limit = setTimeout(onInterrupted, 300000)
      } catch (error) { release(); throw error }
    },
    async stop() {
      if (cancelled || stopped) return new Uint8Array()
      stopped = true
      try {
        if (node) await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('AUDIO_FLUSH')), 3000)
          finish = () => { clearTimeout(timer); resolve() }
          node!.port.postMessage('stop')
        })
        if (cancelled) return new Uint8Array()
        return copy(0, count)
      } finally { release(); chunks = [] }
    },
    cancel() { cancelled = true; finish?.(); release(); chunks = [] },
  }
}
