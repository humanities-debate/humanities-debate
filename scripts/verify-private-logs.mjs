// Local-only bounded scan. Never print log text, token values, account IDs or private paths.
import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
const root = process.cwd()
const roots = [
  ['installed-A', path.join(process.env.APPDATA, 'HumanitiesDebateChrome/profiles/A')],
  ['development-A', path.join(root, '.codex-debate/chrome-prototype/A')],
  ['development-B', path.join(root, '.codex-debate/chrome-prototype/B')],
]
const report = { success: true, scope: 'Local CLI .log files only; excludes browser data and transcript/session files', profiles: [] }
for (const [label, folder] of roots) {
  const result = { label, authCachePresent: false, logFilesScanned: 0, skippedLargeFiles: 0, credentialMatches: 0, tokenShapedMatches: 0, unreadable: 0, truncated: false }
  let secrets = []
  try {
    const auth = JSON.parse(await readFile(path.join(folder, 'codex-auth/auth.json'), 'utf8'))
    result.authCachePresent = true
    secrets = ['access_token', 'refresh_token', 'id_token'].map(key => auth.tokens?.[key]).filter(value => typeof value === 'string' && value.length > 8)
  } catch { /* never expose parser errors or raw auth text */ }
  async function scan(directory, depth = 0) {
    if (depth > 6 || result.logFilesScanned >= 200) return
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch (error) { if (error.code !== 'ENOENT') result.unreadable++; return }
    for (const entry of entries) {
      if (result.logFilesScanned >= 200) { result.truncated = true; break }
      const file = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory() && !['sessions', 'browser', 'launcher'].includes(entry.name)) await scan(file, depth + 1)
      else if (entry.isFile() && /\.log(?:\.[a-zA-Z0-9-]+)?$/.test(entry.name)) {
        try {
          if ((await stat(file)).size > 2_000_000) { result.skippedLargeFiles++; continue }
          const text = await readFile(file, 'utf8')
          result.logFilesScanned++
          if (secrets.some(secret => text.includes(secret))) result.credentialMatches++
          if (/Bearer\s+(?!\[REDACTED\])[a-zA-Z0-9._-]{30,}|eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/.test(text)) result.tokenShapedMatches++
        } catch { result.unreadable++ }
      }
    }
  }
  for (const name of ['codex-auth', '.codex-debate', 'runtime-temp', 'login-work']) await scan(path.join(folder, name))
  if (result.credentialMatches || result.tokenShapedMatches || result.unreadable || result.skippedLargeFiles || result.truncated) report.success = false
  report.profiles.push(result)
}
await mkdir(path.join(root, '.codex-debate/8c-security'), { recursive: true })
await writeFile(path.join(root, '.codex-debate/8c-security/private-logs.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
if (!report.success) process.exitCode = 1
