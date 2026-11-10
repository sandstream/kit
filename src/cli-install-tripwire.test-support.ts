import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { createCliContractFixture } from "./cli-contract.test-support.js";

/** Record and refuse installation subprocesses in an isolated CLI fixture. */
export function installAttemptRecorder(fixture: ReturnType<typeof createCliContractFixture>) {
  const marker = join(fixture.root, "install-attempts.jsonl");
  const preload = join(fixture.root, "install-tripwire.cjs");
  writeFileSync(marker, "");
  writeFileSync(
    preload,
    `
const cp = require('node:child_process');
const fs = require('node:fs');
for (const method of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync']) {
  const original = cp[method];
  cp[method] = function(command, ...args) {
    const text = String(command) + ' ' + JSON.stringify(args[0] || []);
    if (/npm|python|triage/.test(text)) {
      fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({method, command}) + '\\n');
      throw new Error('Fixture refused an installation or triage subprocess');
    }
    return original.call(this, command, ...args);
  };
}
require('node:module').syncBuiltinESMExports();
`,
  );
  fixture.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;
  return marker;
}
