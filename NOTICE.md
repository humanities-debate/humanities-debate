# Humanities Debate — notices

Copyright (c) 2026 Humanities Debate contributors. Independently authored app
code: MIT, with the exclusions in `LICENSE_SCOPE.md`. No personal email or
developer credential is included in this notice.

## OpenAI Sign in with ChatGPT DevKit

Copyright 2026 OpenAI. Original source: `openai/sign-in-with-chatgpt-devkit`,
commit `0a36fefeb913055c8c7a1a29b63d82b96b2e841a`, package `@siwc/local` 0.1.0.
License: Sign-in with ChatGPT DevKit Noncommercial License v1.0, preserved in
`licenses/DEVKIT_LICENSE.txt` and installed `resources/licenses/DEVKIT_LICENSE.txt`.

Original authentication, identity verification and storage source is unchanged.
The bundled derivative replaces the original models/Responses modules with
`server/siwcModels.mjs` and `server/siwcResponses.mjs`. Changes add account model
capabilities, reasoning effort, separate instructions, strict structured output,
bounded completion/cancellation and safe error handling. These changed modules
and the DevKit-derived bundle retain the DevKit license; they are not relicensed
under MIT. Generated bundles carry a prominent modification notice.

The official SDK source and original license are supplied in the public-source
preparation under `third_party/siwc-devkit/`, with original SHA-256 provenance.
No app authentication files, client registration IDs, tokens or browser profiles
are shipped. No OpenAI/ChatGPT trademark ownership or official endorsement is
claimed. The service's eligibility, consent and usage limits remain applicable.

## Runtime license copies

- React, React DOM, scheduler: `THIRD_PARTY_react*.txt`, `THIRD_PARTY_scheduler.txt`.
- SIWC runtime dependencies: `THIRD_PARTY_jose.txt`, `THIRD_PARTY_openai.txt`,
  `THIRD_PARTY_proper-lockfile.txt`, `THIRD_PARTY_graceful-fs.txt`,
  `THIRD_PARTY_retry.txt`, `THIRD_PARTY_signal-exit.txt`.
- OpenAI SDK vendored components: `THIRD_PARTY_openai_qs.txt`,
  `THIRD_PARTY_openai_partial-json-parser.txt`,
  `THIRD_PARTY_openai_zod-to-json-schema.txt`.
- Electron: original `LICENSE` and `LICENSES.chromium.html` accompany the runtime.
  These include its Chromium/Node.js and other third-party acknowledgements.

These license files are installed in `resources/licenses/` unless the original
Electron runtime provides them beside its executable. Original publisher notices
are retained. Microsoft Windows and Google Chrome are prerequisites supplied by
their publishers, not redistributed as part of the app.

Humanities Debate is an unofficial practice tool, not an SK hynix recruiting
service or an official interview scoring system. No additional trademark rights
are granted by the app license.
