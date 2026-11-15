// Verified against the bundled b5454 CLI --help. Never accept renderer-supplied options.
export const VAD_MODEL = 'ggml-silero-v6.2.0.bin'
export const VAD_BYTES = 885098
export const QUALITY_ARGS = [
  '--vad', '--vad-model', VAD_MODEL,
  '--vad-threshold', '0.5', '--vad-min-speech-duration-ms', '250',
  '--vad-min-silence-duration-ms', '500', '--vad-speech-pad-ms', '200',
  '--vad-samples-overlap', '0.1', '--suppress-nst',
  '--no-speech-thold', '0.6', '--temperature', '0', '--temperature-inc', '0.2',
  '--entropy-thold', '2.4', '--logprob-thold', '-1',
]
