// Preserve the pinned official authentication source. Replace only inference adapters
// in this derivative bundle; see SIWC_ADAPTER_NOTICE.txt and the upstream license.
import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'

const root = process.cwd(), output = path.join(root, 'desktop-dist/siwc')
const source = JSON.parse(await readFile('experiments/siwc-8e/source.json', 'utf8'))
const cache = path.join(root, '.codex-debate/siwc-8e-sdk')
for (const [file, hash] of Object.entries(source.files)) {
  const bytes = await readFile(path.join(cache, file))
  if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('OFFICIAL_SDK_HASH_MISMATCH')
}
await mkdir(output, { recursive: true })
const banner = `/* Modified DevKit bundle, Humanities Debate, 2026-11-14.
 * Upstream @siwc/local ${source.version}, commit ${source.commit}.
 * Authentication/storage source unchanged; models/Responses modules substituted
 * with Humanities Debate adapters (reasoning, strict schema, safe errors).
 * DevKit and its modifications: accompanying DEVKIT_LICENSE.txt.
 * Preserve SIWC_ADAPTER_NOTICE.txt and third-party notices. Independent app: MIT;
 * DevKit-derived modules/bundle retain the DevKit license. See LICENSE_SCOPE.md.
 */
import { createRequire as sdkCreateRequire } from 'node:module'; const require = sdkCreateRequire(import.meta.url);`
await build({ stdin: { contents: `export {createChatGPT} from ${JSON.stringify(path.join(cache, 'packages/local/src/index.ts'))};\nexport {ConnectionStore} from ${JSON.stringify(path.join(cache, 'packages/local/src/storage.ts'))};`, resolveDir: root, loader: 'ts' },
  outfile: path.join(output, 'sdk.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24',
  nodePaths: [path.join(root, 'experiments/siwc-8e/node_modules')], banner: { js: banner },
  plugins: [{ name: '8f-inference-adapters', setup(builder) {
    builder.onResolve({ filter: /^@siwc-internal\/errors$/ }, () => ({ path: path.join(cache, 'packages/local/src/errors.ts') }))
    builder.onResolve({ filter: /^\.\/(responses|models)\.js$/ }, args => {
      if (path.resolve(args.resolveDir) !== path.join(cache, 'packages/local/src')) return
      return { path: path.join(root, args.path === './responses.js' ? 'server/siwcResponses.mjs' : 'server/siwcModels.mjs') }
    })
  } }] })
await build({ entryPoints: ['server/siwcRuntime.mjs'], outfile: path.join(output, 'runtime.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24' })
await build({ stdin: { contents: 'export { createDebateServer } from "./server/http.mjs"; export { defaultModelSettings } from "./server/modelCatalog.mjs";', resolveDir: root },
  outfile: path.join(output, 'backend.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24' })
await copyFile(path.join(cache, 'LICENSE'), path.join(output, 'DEVKIT_LICENSE.txt'))
for (const name of ['react', 'react-dom', 'scheduler']) {
  const directory = path.join(root, 'node_modules', name)
  const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
  await writeFile(path.join(output, `THIRD_PARTY_${name}.txt`), `${name} ${metadata.version}\n${await readFile(path.join(directory, 'LICENSE'), 'utf8')}`)
}
for (const [name, license] of [['jose', 'LICENSE.md'], ['openai', 'LICENSE'], ['proper-lockfile', 'LICENSE'], ['graceful-fs', 'LICENSE.md'], ['retry', 'License'], ['signal-exit', 'LICENSE.txt']]) {
  const directory = path.join(root, 'experiments/siwc-8e/node_modules', name)
  const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
  await writeFile(path.join(output, `THIRD_PARTY_${name}.txt`), `${name} ${metadata.version}\n${await readFile(path.join(directory, license), 'utf8')}`)
}
for (const [name, license] of [['qs', 'src/internal/qs/LICENSE.md'], ['partial-json-parser', 'src/_vendor/partial-json-parser/LICENSE'], ['zod-to-json-schema', 'src/_vendor/zod-to-json-schema/LICENSE']]) {
  await copyFile(path.join(root, 'experiments/siwc-8e/node_modules/openai', license), path.join(output, `THIRD_PARTY_openai_${name}.txt`))
}
await writeFile(path.join(output, 'SIWC_ADAPTER_NOTICE.txt'), `Humanities Debate changes, 2026-11-15: official @siwc/local ${source.version} from commit ${source.commit}. Authentication/storage source is unchanged. The derivative bundle replaces models and Responses transport modules with server/siwcModels.mjs and server/siwcResponses.mjs, adding account catalog capabilities, reasoning.effort, separate instructions, strict JSON schema and safe errors. These modified modules and the DevKit-derived bundle retain the accompanying DevKit Noncommercial License. Independently authored app code is MIT; this does not relicense DevKit, dependencies or grant service access. See LICENSE_SCOPE.md and NOTICE.md.\n`)
console.log('SIWC authentication and debate adapters built. No credentials accessed.')
