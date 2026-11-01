const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const original = fs.readFileSync(path.join(process.env.RUNNER_TEMP, 'kit-pwsh-module-path.txt'), 'utf8');
const entries = original.split(';');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-module-probe-'));
try {
  const env = {PATH:process.env.PATH, HOME:home, USERPROFILE:home, SystemRoot:process.env.SystemRoot, COMSPEC:process.env.COMSPEC, PATHEXT:process.env.PATHEXT, TMP:home, TEMP:home, TMPDIR:home};
  const candidates = [['full', original], ['empty', ''], ['system', path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')], ['system-trailing-separator', path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') + ';']];
  entries.forEach((entry, index) => { candidates.push([`only-${index}`, entry]); candidates.push([`without-${index}`, entries.filter((_, i) => i !== index).join(';')]); });
  for (const [name, value] of candidates) {
    const start = Date.now();
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { env: {...env, PSModulePath:value}, timeout:4000, encoding:'utf8', windowsHide:true });
    console.log(JSON.stringify({name, elapsedMs:Date.now()-start, status:result.status, error:result.error?.code ?? null}));
  }
} finally { fs.rmSync(home, { recursive:true, force:true }); }
