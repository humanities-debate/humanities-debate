import { build } from 'esbuild'
import { mkdir, access } from 'node:fs/promises'
import './prepare-whisper.mjs'
await access('node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe')
await mkdir('desktop-dist', { recursive: true })
// Compile existing TypeScript shared data/validators; no runtime TS loader or dev server.
await build({ entryPoints: ['desktop/worker.mjs'], outfile: 'desktop-dist/worker.mjs', bundle: true,
  platform: 'node', format: 'esm', target: 'node24', external: ['./runtime.mjs'], sourcemap: false })
await build({ entryPoints: ['server/codexRuntime.mjs'], outfile: 'desktop-dist/runtime.mjs', bundle: true,
  platform: 'node', format: 'esm', target: 'node24', external: ['@openai/codex-sdk'], sourcemap: false })
console.log('데스크톱 백엔드 빌드 완료 (Codex SDK 0.166.0 / Windows x64)')
