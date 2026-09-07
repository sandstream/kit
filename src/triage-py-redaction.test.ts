/**
 * RED-1: `kit triage repo <url>` and `kit triage docker/npm/pip <url>` echo the raw target
 * back to the operator (both in the final "Triage: <type> <target>" banner and in the
 * `_owner_repo` refusal messages for an unparseable/unsupported-host target). A private
 * clone target can legitimately carry a credential in the URL userinfo
 * (`https://u:ghp_xxx@host/owner/repo.git`), so every one of those echoes must strip it
 * before it reaches stdout / CI logs.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const TRIAGE_PY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "skills",
  "triage",
  "scripts",
  "triage.py",
);

const TOKEN = `ghp_${"A".repeat(40)}`;

/** Skips LOUDLY when python3 is absent: the script under test IS python. */
async function runTriage(
  args: string[],
  env: NodeJS.ProcessEnv,
  t: { skip: (m: string) => void },
): Promise<string | null> {
  try {
    const { stdout } = await exec("python3", [TRIAGE_PY, ...args], { env, timeout: 30_000 });
    return stdout;
  } catch (err) {
    const e = err as { code?: string | number; stdout?: string };
    if (e.code === "ENOENT") {
      t.skip("python3 not installed — triage.py's own behaviour is NOT verified in this run");
      return null;
    }
    // A non-zero exit (e.g. CRITICAL findings) still carries stdout we must check.
    if (e.stdout !== undefined) return e.stdout;
    throw err;
  }
}

describe("triage.py never echoes a credential embedded in the target URL (RED-1)", () => {
  let server: Server;
  let base = "";

  before(async () => {
    server = await new Promise<Server>((res) => {
      const s = createServer((req, r) => {
        if (req.url === "/repos/owner/repo") {
          r.writeHead(200, { "content-type": "application/json" });
          r.end(
            JSON.stringify({
              stargazers_count: 1,
              license: { spdx_id: "MIT" },
              archived: false,
              disabled: false,
              pushed_at: new Date().toISOString(),
              created_at: new Date().toISOString(),
            }),
          );
        } else {
          r.writeHead(404, { "content-type": "application/json" });
          r.end(JSON.stringify({ message: "Not Found" }));
        }
      }).listen(0, "127.0.0.1", () => res(s));
    });
    const addr = server.address();
    base = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("a resolvable github.com target with an embedded token is not echoed", async (t) => {
    const target = `https://u:${TOKEN}@github.com/owner/repo`;
    const stdout = await runTriage(
      ["repo", target],
      { ...process.env, KIT_GITHUB_API: base, GITHUB_TOKEN: "", GH_TOKEN: "" },
      t,
    );
    if (stdout === null) return;
    assert.doesNotMatch(stdout, /ghp_/);
    assert.match(stdout, /Triage: repo/);
  });

  it("an unsupported-host refusal with an embedded token is not echoed", async (t) => {
    const target = `https://u:${TOKEN}@evil.example/owner/repo`;
    const stdout = await runTriage(
      ["repo", target],
      { ...process.env, KIT_GITHUB_API: base, GITHUB_TOKEN: "", GH_TOKEN: "" },
      t,
    );
    if (stdout === null) return;
    assert.doesNotMatch(stdout, /ghp_/);
    assert.match(stdout, /not a github\.com repo URL/);
  });

  it("an unparseable target with an embedded token is not echoed", async (t) => {
    const target = `https://u:${TOKEN}@`;
    const stdout = await runTriage(
      ["repo", target],
      { ...process.env, KIT_GITHUB_API: base, GITHUB_TOKEN: "", GH_TOKEN: "" },
      t,
    );
    if (stdout === null) return;
    assert.doesNotMatch(stdout, /ghp_/);
    assert.match(stdout, /could not parse owner\/repo/);
  });
});
