const RATE = 16000, FRAME = 320, PAD = RATE * 0.2
// Caption boundary finder, not a speech/noise classifier: native Silero VAD decides that.
// The original recording is never changed. Quiet boundaries retain padding on both sides.
export function previewWindow(pcm: Uint8Array): { pcm: Uint8Array; consumeSamples: number } {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const samples = pcm.byteLength / 2
  let quietStart = -1, lastSound = 0
  for (let from = 0; from < samples; from += FRAME) {
    const to = Math.min(samples, from + FRAME)
    let energy = 0, peak = 0
    for (let i = from; i < to; i++) {
      const sample = view.getInt16(i * 2, true)
      energy += sample * sample; peak = Math.max(peak, Math.abs(sample))
    }
    const quiet = Math.sqrt(energy / (to - from)) < 80 && peak < 480
    if (!quiet) { quietStart = -1; lastSound = to }
    else {
      if (quietStart < 0) quietStart = from
      // At least 8 seconds of context and 700 ms of quiet before freezing a caption range.
      if (quietStart >= RATE * 8 && to - quietStart >= RATE * 0.7) {
        const boundary = quietStart + Math.floor((to - quietStart) / 2)
        return { pcm: pcm.subarray(0, boundary * 2), consumeSamples: boundary }
      }
    }
  }
  // Only byte-exact digital silence is skipped; low volume audio still reaches VAD.
  if (!lastSound) return { pcm: pcm.some(byte => byte !== 0) ? pcm : pcm.subarray(0, 0), consumeSamples: 0 }
  const end = Math.min(samples, lastSound + PAD)
  return { pcm: pcm.subarray(end * 2).some(byte => byte !== 0) ? pcm : pcm.subarray(0, end * 2), consumeSamples: 0 }
}
