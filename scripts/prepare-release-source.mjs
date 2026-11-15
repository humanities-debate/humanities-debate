// Creates a private, review-only source snapshot. Never commits, pushes or publishes.
import { execFileSync, spawnSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { inspectReleaseText, privateReleasePath } from './release-policy.mjs'

if (process.argv.slice(2).some(arg => arg !== '--v1')) throw new Error('INVALID_SOURCE_ARGUMENT')
const stable = process.argv.includes('--v1'), version = stable ? '1.0.0' : '0.0.11-rc.1'
const root = process.cwd(), artifacts = path.join(root, '.codex-debate')
await mkdir(artifacts, { recursive: true })
const destination = stable ? path.join(root, 'release/v1.0.0/source') : await mkdtemp(path.join(artifacts, 'release-source-review-'))
if (stable) {
  try { await lstat(destination); throw new Error('SOURCE_DIRECTORY_ALREADY_EXISTS') } catch (error) { if (error.code !== 'ENOENT') throw error }
}
const tracked = execFileSync('git', stable ? ['ls-files', '--cached', '--others', '--exclude-standard', '-z'] : ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
const generatedSource = ['electron-builder.release-candidate.json', 'scripts/release-policy.mjs', 'scripts/verify-release-candidate.mjs', 'scripts/prepare-release-source.mjs', 'tests/releaseSecurity.test.mjs', 'docs/release/USER_GUIDE.md', 'docs/release/PRIVACY.md']
const allowed = name => /^(src|public|server|desktop|scripts|tests)\//.test(name) || /^experiments\/siwc-8e\/[^/]+\.(?:mjs|json|js|html|css)$/.test(name) || /^(?:package(?:-lock)?\.json|index\.html|vite\.config\.ts|eslint\.config\.js|tsconfig[^/]*\.json|electron-builder[^/]*\.json|\.gitignore)$/.test(name) || (stable && (/^licenses\//.test(name) || ['LICENSE', 'LICENSE_SCOPE.md', 'NOTICE.md', 'docs/release/V1_USER_GUIDE.md'].includes(name)))
const selected = [...new Set([...tracked.filter(allowed), ...generatedSource])].sort()
const remote = execFileSync('git', ['config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).trim()
const owner = /github\.com[:/]([^/]+)\//.exec(remote)?.[1]
const authorEmail = execFileSync('git', ['config', '--get', 'user.email'], { encoding: 'utf8' }).trim()
const privateLabels = [owner, authorEmail].filter(Boolean)
const contents = [], findings = []
for (const name of selected) {
  if (privateReleasePath(name)) throw new Error('PRIVATE_PATH_IN_SOURCE_SELECTION')
  const info = await lstat(name)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('UNEXPECTED_SOURCE_LINK')
  const bytes = await readFile(name)
  const rules = inspectReleaseText(bytes.toString('utf8'), privateLabels)
  if (rules.length) findings.push({ file: name, rules, classification: name.startsWith('tests/') ? 'synthetic-fixture-review-required' : 'manual-review-required' })
  contents.push({ name, bytes })
}
// Keep upstream hashes and license separate from the undecided app license.
const upstream = JSON.parse(await readFile('experiments/siwc-8e/source.json', 'utf8'))
for (const [name, expected] of Object.entries(upstream.files)) {
  const bytes = await readFile(path.join('.codex-debate/siwc-8e-sdk', name))
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('UPSTREAM_SOURCE_HASH_MISMATCH')
  contents.push({ name: 'third_party/siwc-devkit/' + name, bytes })
}
if (!stable) contents.push({ name: 'LICENSE_DECISION_PENDING.md', bytes: Buffer.from('# App license decision pending\n\nThis is a PRIVATE REVIEW snapshot, not an approved public source release. No license for independently authored application code has been selected. Third-party and DevKit terms remain in force; the DevKit Noncommercial License is not replaced by a future app license. Review all source-scan findings before publishing.\n') })
contents.push({ name: 'README.md', bytes: Buffer.from(stable
  ? '# Humanities Debate 1.0.0\n\n무료 개인·비상업 로컬 인문학 토론 연습 프로그램입니다. SK하이닉스·OpenAI의 공식 채용 서비스나 평가 도구가 아닙니다. AI 토론 세 명, Chrome 한국어 음성 입력, 토론 기록과 100점 연습 피드백을 제공합니다.\n\n## 라이선스\n\n독립 작성 앱 코드는 MIT입니다. 포함된 Sign in with ChatGPT DevKit, 수정된 server/siwcResponses.mjs 및 server/siwcModels.mjs는 별도 DevKit Noncommercial License v1.0입니다. **전체 배포물은 상업적 사용까지 허용하는 단일 MIT 제품이 아닙니다.** LICENSE_SCOPE.md, NOTICE.md, licenses/DEVKIT_LICENSE.txt를 확인하세요. 무료라도 사업·고용주·고객의 운영이나 상업적 이익을 위한 사용에는 이 DevKit 라이선스가 권한을 부여하지 않습니다.\n\n## 사용 환경과 인증\n\nWindows x64, Google Chrome 정식 버전, 인터넷과 적격 본인 ChatGPT 계정이 필요합니다. 공식 로그인과 구독 사용 동의를 이용하며 개발자 API 키·인증정보를 제공하지 않습니다. 계정 한도와 모델 접근 제한이 적용됩니다. Chrome 음성 처리는 온라인 서비스를 사용할 수 있습니다. docs/release/V1_USER_GUIDE.md와 PRIVACY.md를 확인하세요.\n\n## 소스에서 빌드\n\nWindows x64 + Node.js 24 LTS에서 아래 명령을 순서대로 실행합니다.\n\n```powershell\nnpm ci\nnpm --prefix experiments/siwc-8e ci\nnpm run build\nnpm run lint\nnpm run test\nnpm run release:v1\nnpm run release:verify:v1\n```\n\n제품 버전은 electron-builder.v1.json과 package.json에 1.0.0으로 지정되어 있습니다. 설치 파일은 release/v1.0.0에 생성됩니다. SDK 준비는 source.json의 고정 공식 커밋과 해시를 확인합니다. 설치 후 이용자에게 Node.js·VS Code는 필요하지 않습니다. 개발용 실행은 npm run siwc:app -- --profile=Quality이며, 실제 AI 호출은 본인이 로그인하고 토론·분석을 요청할 때만 발생합니다.\n\n## 출처와 공개 상태\n\nSOURCE_INVENTORY.json에 파일별 SHA-256을 제공합니다. third_party/siwc-devkit에는 빌드에 사용한 공식 원본 소스·라이선스를 보존했습니다. 기존 개발 저장소의 .git·개인 이력·인증·브라우저·개인 기록·녹음·설치 파일은 포함하지 않았습니다. tests의 비밀값·계정은 합성 fixture입니다. 인증 토큰·비밀번호·개인 토론 원문을 개발자에게 보내지 마세요.\n\n이 소스는 공개 준비된 로컬 묶음입니다. 사용자 새 설치판 실행 확인 전에는 Public Release와 홈페이지 다운로드를 게시하지 않습니다. 다른 실제 PC·계정 검사는 미검증이며 코드 서명·보안 경고와 서비스 제약을 확인해야 합니다. 다운로드 횟수는 GitHub 설치 파일 다운로드 이벤트이며 고유 사용자 수가 아닙니다.\n\n홈페이지: https://humanities-debate.github.io/\n'
  : '# Humanities Debate — source review candidate\n\n배포 검토용 0.0.11-rc.1 소스입니다. 라이선스 범위와 공개 승인을 확인하기 전에는 게시하지 않습니다.\n\nWindows x64 + Node.js 24 LTS: npm ci, npm --prefix experiments/siwc-8e ci, npm run release:candidate, npm run release:verify. 공식 SDK 원본은 third_party/siwc-devkit와 source.json을 확인하세요. 기존 개발 이력·인증·기록·설치 파일은 포함하지 않습니다.\n') })
const inventory = []
for (const { name, bytes } of contents) {
  const output = path.join(destination, name)
  await mkdir(path.dirname(output), { recursive: true })
  await writeFile(output, bytes)
  inventory.push({ file: name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
}
await writeFile(path.join(destination, 'SOURCE_INVENTORY.json'), JSON.stringify({ version, licensePending: !stable, publicApproved: false, findings, files: inventory }, null, 2))
const require = createRequire(import.meta.url)
const sevenZip = await require('app-builder-lib/out/toolsets/7zip.js').getPath7za()
const archive = path.join(root, stable ? 'release/v1.0.0/HumanitiesDebate-Source-1.0.0.zip' : 'release-candidate/HumanitiesDebate-Source-0.0.11-rc.1-LICENSE-PENDING.zip')
try { await lstat(archive); throw new Error('SOURCE_ARCHIVE_ALREADY_EXISTS; keep it and choose a new reviewed version') } catch (error) { if (error.code !== 'ENOENT') throw error }
const result = spawnSync(sevenZip, ['a', '-tzip', archive, '.'], { cwd: destination, windowsHide: true, encoding: 'utf8', timeout: 60000 })
if (result.status !== 0) throw new Error('SOURCE_REVIEW_ARCHIVE_FAILED')
const report = { privateReviewOnly: !stable, publicApproved: false, licensePending: !stable, sourceFileCount: inventory.length,
  reviewDirectory: path.relative(root, destination).replaceAll('\\', '/'), archive: path.relative(root, archive).replaceAll('\\', '/'), findings }
await writeFile(path.join(root, stable ? '.codex-debate/release-v1.0.0/source-review.json' : '.codex-debate/release-source-review.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
