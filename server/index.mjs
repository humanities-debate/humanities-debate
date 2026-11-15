import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCodexRuntime } from './codexRuntime.mjs'
import { createDebateServer } from './http.mjs'
import { DebateError } from './dialogue.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let runtime
let app
let closing = false
async function shutdown() {
  if (closing) return
  closing = true
  try {
    await app?.close()
    await runtime?.cleanup()
    console.log('AI 서버 종료: 요청 중단 및 임시 인증/대화 파일 정리 완료')
  } catch {
    console.error('임시 파일 정리에 실패했습니다. .codex-debate 폴더를 공유하지 마세요.')
    process.exitCode = 1
  }
}
try {
  runtime = await createCodexRuntime(root)
  app = createDebateServer(runtime.generate, { models: runtime.models, defaultSettings: runtime.defaultSettings, analyze: runtime.analyze })
  await new Promise((resolve, reject) => {
    app.server.once('error', reject)
    app.server.listen(3001, '127.0.0.1', resolve)
  })
  console.log(`AI 서버: http://127.0.0.1:3001 · 기본 ${runtime.defaultSettings.model} / ${runtime.defaultSettings.reasoningEffort} · ChatGPT 로그인 (API 키 없음)`)
  console.log('웹 화면은 별도 터미널에서 npm run dev → http://127.0.0.1:5173')
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
} catch (error) {
  console.error('AI 서버 시작 실패: ' + (error instanceof DebateError ? error.code : error?.code === 'EADDRINUSE' ? '3001 포트가 사용 중입니다.' : '로컬 실행 환경을 확인해 주세요.'))
  await shutdown()
  process.exitCode = 1
}
