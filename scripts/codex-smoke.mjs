import { Codex } from '@openai/codex-sdk'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { mkdir, mkdtemp, readFile, writeFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { QUESTION, MODEL, childEnvironment, safeConfig, validateChatGPTCache, redact } from './codex-smoke-policy.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = path.join(root, '.codex-smoke')
const sourceHome = process.env.CODEX_HOME || path.join(homedir(), '.codex')
const require = createRequire(import.meta.url)
const question = process.argv[2]?.trim() || QUESTION
const started = performance.now()
const report = { startedAt: new Date().toISOString(), success: false, authentication: 'not_verified', modelRequested: MODEL, modelVerified: false, question, response: null, elapsedSeconds: null, inferenceSeconds: null, toolEvents: 0 }
let authCopy
let secrets = []
let timer
let inferenceStarted
const abort = new AbortController()
const onInterrupt = () => abort.abort()
process.once('SIGINT', onInterrupt)
process.once('SIGTERM', onInterrupt)

try {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('이 테스트 실행기는 Windows x64 환경을 대상으로 합니다.')
  await mkdir(artifacts, { recursive: true })
  const runDirectory = await mkdtemp(path.join(artifacts, 'run-'))
  // Lock the directory BEFORE creating the temporary credential copy.
  const identity = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true })
  const sid = identity.stdout?.match(/S-1-5-(?:\d+-)*\d+/)?.[0]
  if (identity.status !== 0 || !sid) throw new Error('현재 Windows 사용자 SID를 확인하지 못해 인증 복사를 중단했습니다.')
  const acl = spawnSync('icacls.exe', [runDirectory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { encoding: 'utf8', windowsHide: true })
  if (acl.status !== 0) throw new Error('테스트 폴더의 사용자 전용 접근 권한을 설정하지 못했습니다.')
  const runtimeHome = path.join(runDirectory, 'home')
  const workDirectory = path.join(runDirectory, 'empty-work')
  const tempDirectory = path.join(runDirectory, 'temp')
  await Promise.all([runtimeHome, workDirectory, tempDirectory].map(dir => mkdir(dir)))
  const cached = await readFile(path.join(sourceHome, 'auth.json'), 'utf8')
  const auth = JSON.parse(cached)
  validateChatGPTCache(auth)
  secrets = Object.values(auth.tokens).filter(value => typeof value === 'string')
  authCopy = path.join(runtimeHome, 'auth.json')
  await writeFile(authCopy, cached, { flag: 'wx', mode: 0o600 })
  const env = childEnvironment(process.env, runtimeHome, tempDirectory)
  const packageRoot = path.dirname(require.resolve('@openai/codex-win32-x64/package.json'))
  const binary = path.join(packageRoot, 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe')
  const version = spawnSync(binary, ['--version'], { env, cwd: workDirectory, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  if (version.status !== 0 || !version.stdout.includes('0.166.0')) throw new Error('검증한 Codex CLI 0.166.0과 실행 파일 버전이 다릅니다.')
  const login = spawnSync(binary, ['login', 'status'], { env, cwd: workDirectory, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  if (login.status !== 0 || !`${login.stdout}\n${login.stderr}`.includes('Logged in using ChatGPT')) {
    throw new Error('CHATGPT_LOGIN_REQUIRED: 격리된 CLI에서 ChatGPT 로그인을 확인하지 못했습니다.')
  }
  report.authentication = 'ChatGPT cached login (temporary protected copy)'
  console.log('인증: 기존 Codex의 ChatGPT 로그인 확인 (API 키 사용 안 함)')
  console.log(`요청 모델: ${MODEL}`)
  console.log(`질문: ${question}`)
  const codex = new Codex({ env, codexPathOverride: binary, config: safeConfig(runtimeHome) })
  const thread = codex.startThread({
    model: MODEL, modelReasoningEffort: 'low', workingDirectory: workDirectory,
    skipGitRepoCheck: true, sandboxMode: 'read-only', approvalPolicy: 'never',
    webSearchMode: 'disabled', networkAccessEnabled: false,
  })
  // Match the actual process cwd too, so parent-project configuration is not inferred.
  process.chdir(workDirectory)
  timer = setTimeout(() => abort.abort(), 120000)
  inferenceStarted = performance.now()
  const { events } = await thread.runStreamed(question, { signal: abort.signal })
  let completed = false
  let response = ''
  for await (const event of events) {
    if (event.type === 'turn.failed') throw new Error(event.error.message)
    if (event.type === 'error') {
      report.warnings ??= []
      report.warnings.push(redact(event.message, secrets).slice(0,1000))
      continue
    }
    if (event.type.startsWith('item.') && event.item) {
      // SDK ErrorItem is non-fatal (for example a config deprecation warning).
      // Only turn.completed plus nonempty output can establish inference success.
      if (event.item.type === 'error') {
        report.warnings ??= []
        report.warnings.push(redact(event.item.message, secrets).slice(0,1000))
        continue
      }
      if (!['agent_message', 'reasoning'].includes(event.item.type)) {
        report.toolEvents++
        abort.abort()
        throw new Error('예상하지 않은 도구/오류 이벤트가 발생해 테스트를 중단했습니다: ' + event.item.type)
      }
      if (event.type === 'item.completed' && event.item.type === 'agent_message') response = event.item.text
    }
    if (event.type === 'turn.completed') {
      completed = true
      report.usage = event.usage
    }
  }
  if (!completed || !response.trim()) throw new Error('완료 이벤트 또는 최종 응답이 없어 성공으로 처리하지 않았습니다.')
  report.success = true
  report.modelVerified = true
  report.response = redact(response, secrets)
  console.log('\n실제 AI 응답:\n' + report.response)
} catch (error) {
  report.error = redact(error instanceof Error ? error.message : error, secrets).slice(0,2000)
  console.error('\n연결 테스트 실패: ' + report.error)
  process.exitCode = 1
} finally {
  clearTimeout(timer)
  if (inferenceStarted !== undefined) report.inferenceSeconds = Number(((performance.now() - inferenceStarted) / 1000).toFixed(3))
  if (authCopy) {
    try { await unlink(authCopy) } catch (error) {
      if (error.code !== 'ENOENT') {
        report.credentialCleanupFailed = true
        console.error('임시 인증 파일 정리에 실패했습니다. .codex-smoke 폴더를 공유하지 마세요.')
        process.exitCode = 1
      }
    }
  }
  process.chdir(root)
  process.removeListener('SIGINT', onInterrupt)
  process.removeListener('SIGTERM', onInterrupt)
  report.elapsedSeconds = Number(((performance.now() - started) / 1000).toFixed(3))
  await mkdir(artifacts, { recursive: true })
  await writeFile(path.join(artifacts, 'last-result.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(`소요 시간: ${report.inferenceSeconds ?? '요청 전 중단'}초 (전체 ${report.elapsedSeconds}초)`)
  console.log('검증 결과: .codex-smoke/last-result.json (Git 제외)')
}
