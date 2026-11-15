// Downloads unmodified official source to a Git-ignored cache. Never reads authentication.
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'

const directory = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(directory, '../..')
const source = JSON.parse(await readFile(path.join(directory, 'source.json'), 'utf8'))
const cache = path.join(root, '.codex-debate/siwc-8e-sdk')
const output = path.join(root, '.codex-debate/siwc-8e-build')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
for (const [name, expected] of Object.entries(source.files)) {
  const target = path.join(cache, name)
  let bytes
  try { bytes = await readFile(target) } catch { /* First preparation. */ }
  if (!bytes || hash(bytes) !== expected) {
    const response = await fetch(`https://raw.githubusercontent.com/${source.repository}/${source.commit}/${name}`,
      { redirect: 'error', signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error('OFFICIAL_SOURCE_DOWNLOAD_FAILED')
    bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > 128 * 1024 || hash(bytes) !== expected) throw new Error('OFFICIAL_SOURCE_HASH_MISMATCH')
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, bytes)
  }
}
await mkdir(output, { recursive: true })
await build({ stdin: { contents: `export { createChatGPT } from ${JSON.stringify(path.join(cache, 'packages/local/src/index.ts'))};
export { ConnectionStore } from ${JSON.stringify(path.join(cache, 'packages/local/src/storage.ts'))};`, resolveDir: root, loader: 'ts' },
  outfile: path.join(output, 'official-sdk.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24',
  nodePaths: [path.join(directory, 'node_modules')], legalComments: 'inline',
  banner: { js: "import { createRequire as sdkCreateRequire } from 'node:module'; const require = sdkCreateRequire(import.meta.url);" } })
await copyFile(path.join(cache, 'LICENSE'), path.join(output, 'DEVKIT_LICENSE.txt'))
console.log('SIWC official SDK prepared; original source hashes verified. No authentication accessed.')
