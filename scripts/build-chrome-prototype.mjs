import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
await mkdir('desktop-dist', { recursive: true })
await build({ entryPoints: ['desktop/worker.mjs'], outfile: 'desktop-dist/worker.mjs', bundle: true,
  platform: 'node', format: 'esm', target: 'node24', external: ['./runtime.mjs'] })
await build({ entryPoints: ['server/codexRuntime.mjs'], outfile: 'desktop-dist/runtime.mjs', bundle: true,
  platform: 'node', format: 'esm', target: 'node24', external: ['@openai/codex-sdk'] })
console.log('Chrome 검증판 백엔드 빌드 완료. 기존 Electron 설치 파일은 변경하지 않았습니다.')
