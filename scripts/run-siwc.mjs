import { spawn } from 'node:child_process'
import path from 'node:path'
import electron from 'electron'
const args = process.argv.slice(2)
if (args.some(value => value !== '--verify' && !/^--profile=[a-zA-Z0-9-]{1,40}$/.test(value))) throw new Error('INVALID_SIWC_ARGUMENT')
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  new Set(['systemroot', 'windir', 'path', 'pathext', 'userprofile', 'appdata', 'localappdata', 'temp', 'tmp', 'programfiles', 'programfiles(x86)']).has(key.toLowerCase())))
const child = spawn(electron, [path.resolve('desktop/chrome-siwc-main.mjs'), ...args], { env, windowsHide: false, stdio: 'ignore' })
child.once('error', () => { console.error('공식 ChatGPT 연결판을 실행하지 못했습니다.'); process.exitCode = 1 })
child.once('exit', code => { process.exitCode = code ?? 1 })
console.log('공식 ChatGPT 연결판을 별도 경로에서 시작합니다. 인증 정보는 출력하지 않습니다.')
