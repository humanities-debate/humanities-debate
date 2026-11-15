import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'
import { prototypeEnvironment } from './policy.mjs'

const directory = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
if (args.some(value => value !== '--verify-encryption')) throw new Error('지원하지 않는 프로토타입 실행 옵션')
const child = spawn(electron, [path.join(directory, 'main.mjs'), ...args], {
  // This is an interactive test window; do not inherit a hidden startup show state.
  cwd: path.resolve(directory, '../..'), env: prototypeEnvironment(process.env), windowsHide: false, stdio: 'ignore',
})
child.once('error', () => { console.error('SIWC 프로토타입 실행 실패'); process.exitCode = 1 })
child.once('exit', code => { process.exitCode = code ?? 1 })
console.log('별도 SIWC 실험 창을 실행합니다. 인증 정보는 터미널에 출력하지 않습니다.')
