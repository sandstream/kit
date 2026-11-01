const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const original = fs.readFileSync(path.join(process.env.RUNNER_TEMP, 'kit-pwsh-module-path.txt'), 'utf8');
const entries = original.split(';');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-module-probe-'));
try {
  const env = {PATH:process.env.PATH, HOME:home, USERPROFILE:home, SystemRoot:process.env.SystemRoot, COMSPEC:process.env.COMSPEC, PATHEXT:process.env.PATHEXT, TMP:home, TEMP:home, TMPDIR:home};
  const candidates = [['full', original], ['empty', ''], ['system', path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')], ['system-trailing-separator', path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') + ';']];
  candidates.push(['bash-original', process.env.PSModulePath]);
  entries.forEach((entry, index) => { candidates.push([`without-${index}`, entries.filter((_, i) => i !== index).join(';')]); });
  const moduleUrl = pathToFileURL(path.resolve('dist/utils/secure-perms.js')).href;
  const script = `import {secureFileStrict,privateFileIsControlled} from ${JSON.stringify(moduleUrl)}; try {secureFileStrict(process.argv[1]); if (!privateFileIsControlled(process.argv[1])) throw Error('ACL verification failed'); process.stdout.write('OK');} catch (e) {process.stderr.write(JSON.stringify({code:e.cause?.code ?? null})); process.exitCode=1;}`;
  for (const [name, value] of candidates) {
    const start = Date.now();
    const file = path.join(home, `${name}.txt`);
    fs.writeFileSync(file, 'fixture');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, file], { env: {...env, PSModulePath:value}, timeout:20000, encoding:'utf8', windowsHide:true });
    let code = result.error?.code ?? null;
    try { code = JSON.parse(result.stderr).code ?? code; } catch {}
    console.log(JSON.stringify({name, elapsedMs:Date.now()-start, status:result.status, ok:result.stdout === 'OK', error:code}));
  }
} finally { fs.rmSync(home, { recursive:true, force:true }); }
