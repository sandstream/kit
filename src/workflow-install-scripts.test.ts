import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The wfx-loot campaign (2026-11) added a `postinstall` to a repository's own package.json, and the
// repository's trusted workflow ran it at `npm ci`, with the job's secrets in its environment. A job
// that holds a secret or can mint an OIDC token must not run install-time scripts: npm 12's
// default skips dependency scripts only, and the runners here use npm 10 or 11 anyway.

const workflows = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows");

/** Each job under `jobs:` as [name, text], split on two-space-indented keys. */
function jobs(text: string): [string, string][] {
  const body = text.slice(text.indexOf("\njobs:"));
  const parts = body.split(/\n(?= {2}[A-Za-z0-9_-]+:\s*$)/m).slice(1);
  return parts.map((p) => [p.trim().split(":")[0], p]);
}

const holdsCredential = (job: string) =>
  /\$\{\{\s*secrets\./.test(job) || /id-token:\s*write/.test(job);

/** `npm ci` / `npm install` / `npm i` commands in a job that do not pass --ignore-scripts. */
function scriptedInstalls(job: string): string[] {
  return job
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .filter((line) => /\bnpm (ci|install|i)\b/.test(line))
    .filter((line) => !line.includes("--ignore-scripts"))
    .map((line) => line.trim());
}

describe("workflow installs in credentialed jobs", () => {
  it("pass --ignore-scripts wherever a job holds a secret or id-token: write", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(workflows).filter((f) => /\.ya?ml$/.test(f))) {
      for (const [name, job] of jobs(readFileSync(join(workflows, file), "utf8"))) {
        if (!holdsCredential(job)) continue;
        for (const line of scriptedInstalls(job)) offenders.push(`${file} ${name}: ${line}`);
      }
    }
    assert.deepEqual(offenders, [], "install-time scripts would run with the job's credentials");
  });

  it("detects the shape it guards against", () => {
    const job = "  deps:\n    env:\n      T: ${{ secrets.T }}\n    steps:\n      - run: npm ci\n";
    assert.equal(holdsCredential(job), true);
    assert.deepEqual(scriptedInstalls(job), ["- run: npm ci"]);
    assert.deepEqual(scriptedInstalls("      - run: npm ci --ignore-scripts\n"), []);
  });
});
