// Electron harness: packaged SDK/runtime/CLI, existing developer's official login.
// This does NOT establish new-user login or installation success.
import { app, utilityProcess } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const directory = path.join(root, '.codex-debate', 'packaged-ai-check')
app.setPath('userData', directory)
app.whenReady().then(async () => {
  await mkdir(directory, { recursive: true })
  // Code uses only synthetic debate data. Credentials are handled by the existing isolated runtime.
  const script = `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const spawn = childProcess.spawn;
childProcess.spawn = (file,args,options) => spawn(file,args,{...options,windowsHide:true});
syncBuiltinESMExports();
const {createCodexRuntime} = await import(${JSON.stringify(new URL('../release/win-unpacked/resources/app.asar/desktop-dist/runtime.mjs', import.meta.url).href)});
let runtime;
const report = {success:false, authentication:'unverified', packagedResources:true, newUserLogin:false};
try {
 const version = childProcess.spawnSync(${JSON.stringify(path.join(root, 'release/win-unpacked/resources/codex/bin/codex.exe'))}, ['--version'], {encoding:'utf8',windowsHide:true,timeout:15000});
 report.cliCheck = {status:version.status, error:version.error?.code, output:version.stdout?.trim()};
 runtime = await createCodexRuntime(${JSON.stringify(directory)}, {binary:${JSON.stringify(path.join(root, 'release/win-unpacked/resources/codex/bin/codex.exe'))}});
 report.authentication='existing ChatGPT login; no API key';
 const result = await runtime.generate({speakerId:'ai1',topic:'채용에서 AI의 판단을 어디까지 믿어도 될까?',history:[],modelSettings:runtime.defaultSettings},new AbortController().signal);
 report.model=result.model; report.reasoningEffort=result.reasoningEffort; report.elapsedSeconds=result.elapsedSeconds;
 report.reply=result.text; report.execution=await runtime.readLastExecutionSettings(); report.success=true;
} catch(error) { report.error=error.code || 'PACKAGED_RUNTIME_FAILED'; }
finally { await runtime?.cleanup(); process.parentPort.postMessage(report); }
`
  const entry = path.join(directory, 'check.mjs')
  await writeFile(entry, script)
  const worker = utilityProcess.fork(entry, [], { cwd: directory, stdio: 'ignore' })
  const deadline = setTimeout(() => { worker.kill(); app.exit(1) }, 180000)
  worker.on('message', async report => {
    clearTimeout(deadline)
    await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
    worker.kill(); app.exit(report.success ? 0 : 1)
  })
  worker.on('exit', code => { if (code && !app.isQuitting) { clearTimeout(deadline); app.exit(1) } })
})
