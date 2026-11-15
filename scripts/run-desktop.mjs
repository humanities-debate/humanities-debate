import { spawn } from 'node:child_process'
import electron from 'electron'
import path from 'node:path'
const env = { ...process.env }
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key]
const args = process.argv.slice(2)
if (args[0] === 'scripts/verify-desktop.mjs') {
  const { build } = await import('esbuild')
  await build({ entryPoints: [args[0]], outfile: '.codex-debate/verify-desktop.mjs', bundle: true,
    platform: 'node', format: 'esm', target: 'node24', external: ['electron', '../desktop/main.mjs'] })
  args[0] = '.codex-debate/verify-desktop.mjs'
  args.push('--user-data-dir=' + path.resolve('.codex-debate/desktop-check/profile'))
}
const child = spawn(electron, args.length ? args : ['.'], { env, windowsHide: true, stdio: 'inherit' })
child.on('error', () => { console.error('Electron을 실행하지 못했습니다. 의존성 설치를 확인해 주세요.'); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
