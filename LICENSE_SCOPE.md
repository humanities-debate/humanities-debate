# License scope / 라이선스 적용 범위

The independently authored Humanities Debate application is licensed under the
MIT License in `LICENSE`, subject to the following explicit exclusions.
This is a multi-license distribution, not an all-MIT executable.

## Sign in with ChatGPT DevKit — separate noncommercial terms

The following remain under the **Sign-in with ChatGPT DevKit Noncommercial
License v1.0**, reproduced verbatim in `licenses/DEVKIT_LICENSE.txt`:

- Original OpenAI-authored DevKit source fetched at the commit and SHA-256 values
  in `experiments/siwc-8e/source.json`. Source distributions include these files
  in `third_party/siwc-devkit/`.
- `server/siwcResponses.mjs` and `server/siwcModels.mjs`: the modified replacement
  modules used inside the DevKit bundle, including our contributions to them.
- The DevKit-derived portion of generated `desktop-dist/siwc/sdk.mjs` and its
  separately licensed dependencies, as identified by the accompanying notices.

Independently authored application code does not become a DevKit modification
merely by calling its interface. The MIT grant does not relicense the DevKit,
its modifications, bundled dependencies, OpenAI trademarks or service access.

The DevKit permits redistribution only for its defined Noncommercial Purposes.
Its definition excludes business/employer/client operations or commercial
advantage even when no fee is charged. Commercial use of OpenAI's contribution
requires a separate written agreement with OpenAI. Read the actual license;
"free to download" is not an unrestricted commercial-use grant.

## Other third-party materials

React, React DOM, scheduler, Electron, Chromium/Node.js and the SIWC runtime
dependencies retain their own licenses. `NOTICE.md` and the installed
`resources/licenses/` directory identify the preserved license copies.
Electron's `LICENSE` and `LICENSES.chromium.html` remain in the app distribution.
Build-only dependencies and the preserved optional legacy Codex SDK keep the
licenses delivered by their publishers; the Chrome v1.0.0 installer does not
bundle the Codex SDK or Whisper runtime/model.

## 한국어 안내

앱의 독립 작성 코드에는 MIT를 적용합니다. 그러나 포함된 DevKit과 위 수정
모듈에는 비상업 조건이 남으므로, 전체 설치판을 상업적 사용까지 허용하는
단일 MIT 제품으로 표시하지 않습니다. 무료 개인·비상업 로컬 연습용으로
준비한 배포이며, OpenAI 서비스 이용 권한·구독 동의·한도는 코드 라이선스와
별개입니다. 공식 인증 문서: https://developers.openai.com/siwc/token-sharing-open-source
