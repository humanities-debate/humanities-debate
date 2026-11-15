// Audio never leaves the local renderer. Emit PCM in order, then acknowledge the final flush.
class PCMCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.stopped = false
    this.buffer = new Int16Array(1600)
    this.offset = 0
    this.port.onmessage = event => {
      if (event.data === 'stop') {
        this.flush()
        this.stopped = true
        this.port.postMessage({ ended: true })
      }
    }
  }
  flush() {
    if (!this.offset) return
    const chunk = this.buffer.slice(0, this.offset)
    this.port.postMessage({ pcm: chunk }, [chunk.buffer])
    this.offset = 0
  }
  process(inputs) {
    if (this.stopped) return false
    const input = inputs[0]?.[0]
    if (input) for (const sample of input) {
      this.buffer[this.offset++] = Math.round(Math.max(-1, Math.min(1, sample)) * 32767)
      if (this.offset === this.buffer.length) this.flush()
    }
    return true
  }
}
registerProcessor('pcm-capture', PCMCapture)
