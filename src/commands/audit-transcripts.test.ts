import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cmdAuditTranscripts } from "./audit-transcripts.js";
import {
  ACCOUNT_EMAIL,
  GIT_EMAIL,
  GIT_NAME,
  identityFixture,
  toolUse,
} from "../transcript-identity.test-support.js";

async function run(
  args: string[],
  where: { cwd: string; home: string; env: NodeJS.ProcessEnv },
): Promise<{ ok: boolean; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    const ok = await cmdAuditTranscripts(["transcripts", ...args], where);
    return { ok, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

function setup(t: { after(fn: () => void): void }) {
  const f = identityFixture(t);
  f.transcript("s.jsonl", [
    toolUse("Bash", {
      command: `curl -H "User-Agent: x (${ACCOUNT_EMAIL})" https://api.example.net`,
    }),
    toolUse("Bash", { command: `git commit --author="${GIT_NAME} <${GIT_EMAIL}>"` }),
  ]);
  return { cwd: f.root, home: f.home, env: f.env };
}

describe("kit audit transcripts", () => {
  it("refuses without --identity and says how to call it", async (t) => {
    const r = await run([], setup(t));
    assert.equal(r.ok, false);
    assert.match(r.err, /--identity/);
  });

  it("prints counts by kind, tool and host, never a value, and exits 0", async (t) => {
    const r = await run(["--identity"], setup(t));
    assert.equal(r.ok, true);
    assert.match(r.out, /2 tool call\(s\) carried an identity; 1 network-shaped/);
    assert.match(r.out, /account-email\s+1 \(1 network-shaped\)/);
    const rows = r.out.split("\n").map((l) => l.trim().split(/\s+/).join(" "));
    assert.ok(rows.includes("api.example.net 1"), r.out);
    for (const v of ["alice", "carol", "Fixture"]) assert.equal(r.out.includes(v), false, v);
  });

  it("emits JSON with --json", async (t) => {
    const r = await run(["--identity", "--json"], setup(t));
    const parsed = JSON.parse(r.out) as { hits: number; networkHits: number };
    assert.deepEqual([parsed.hits, parsed.networkHits], [2, 1]);
  });

  it("fails with --fail-on-network when a network-shaped call carried an identity", async (t) => {
    const r = await run(["--identity", "--json", "--fail-on-network"], setup(t));
    assert.equal(r.ok, false);
  });

  it("passes --fail-on-network when no call was network-shaped", async (t) => {
    const f = identityFixture(t);
    f.transcript("s.jsonl", [toolUse("Bash", { command: `git log --author="${GIT_NAME}"` })]);
    const r = await run(["--identity", "--fail-on-network"], {
      cwd: f.root,
      home: f.home,
      env: f.env,
    });
    assert.equal(r.ok, true);
  });
});
