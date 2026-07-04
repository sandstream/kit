import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brokerExec, runBrokered, type BrokerContext } from "./broker.js";
import type { BrokerPolicy } from "./policy.js";

const POLICY: BrokerPolicy = {
  egress: { allow: ["api.example.com"] },
  fs: { root: "/repo" },
  env: { declared: ["TOKEN", "REGION"] },
};

const CTX = (over: Partial<BrokerContext> = {}): BrokerContext => ({
  operation: "test.op",
  operationType: "write",
  ...over,
});

let cwd: string;
let sandbox: string;
let identityDir: string;

function auditLines(): Record<string, unknown>[] {
  const p = join(sandbox, ".kit-audit.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(() => {
  cwd = process.cwd();
  sandbox = mkdtempSync(join(tmpdir(), "kit-broker-"));
  // Isolate identity so audit signing never touches a real ~/.kit.
  identityDir = mkdtempSync(join(tmpdir(), "kit-broker-id-"));
  process.env.KIT_IDENTITY_DIR = identityDir;
  process.chdir(sandbox);
});

afterEach(() => {
  process.chdir(cwd);
  delete process.env.KIT_IDENTITY_DIR;
  rmSync(sandbox, { recursive: true, force: true });
  rmSync(identityDir, { recursive: true, force: true });
});

describe("brokerExec default-deny", () => {
  it("denies when policy is null and NEVER runs the op", async () => {
    let ran = false;
    const out = await brokerExec(CTX(), null, async () => {
      ran = true;
      return 1;
    });
    assert.equal(out.ok, false);
    assert.match(out.reason ?? "", /no policy \(default-deny\)/);
    assert.equal(ran, false);
    const lines = auditLines();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].success, false);
  });

  it("denies when policy is undefined", async () => {
    const out = await brokerExec(CTX(), undefined, async () => 1);
    assert.equal(out.ok, false);
  });
});

describe("brokerExec per-gate denial", () => {
  it("denies an out-of-allowlist egress target and does not run", async () => {
    let ran = false;
    const out = await brokerExec(CTX({ egressTargets: ["https://evil.com"] }), POLICY, async () => {
      ran = true;
      return 1;
    });
    assert.equal(out.ok, false);
    assert.equal(ran, false);
    assert.equal(out.denials?.length, 1);
    assert.equal(auditLines().at(-1)?.success, false);
  });

  it("denies an fs-write escaping root", async () => {
    const out = await brokerExec(CTX({ fsWrites: ["/repo/../etc/passwd"] }), POLICY, async () => 1);
    assert.equal(out.ok, false);
    assert.equal(out.denials?.length, 1);
  });

  it("denies an undeclared env key", async () => {
    const out = await brokerExec(
      CTX({ envRequested: ["SECRET_UNDECLARED"] }),
      POLICY,
      async () => 1,
    );
    assert.equal(out.ok, false);
    assert.equal(out.denials?.length, 1);
  });

  it("collects multiple denials across gates", async () => {
    const out = await brokerExec(
      CTX({
        egressTargets: ["https://evil.com"],
        fsWrites: ["../outside"],
        envRequested: ["NOPE"],
      }),
      POLICY,
      async () => 1,
    );
    assert.equal(out.ok, false);
    assert.equal(out.denials?.length, 3);
  });
});

describe("brokerExec fail-closed audit", () => {
  it("refuses to run when the pre-exec 'authorized' audit append fails", async () => {
    // Force appendAuditEventDirect to return false by making the audit path a
    // DIRECTORY, so appendFile fails with EISDIR even as root (permission-
    // independent).
    mkdirSync(join(sandbox, ".kit-audit.jsonl"));
    let ran = false;
    const out = await brokerExec(CTX(), POLICY, async () => {
      ran = true;
      return 1;
    });
    assert.equal(out.ok, false);
    assert.match(out.reason ?? "", /audit-log unavailable.*fail-closed/);
    assert.equal(ran, false);
  });
});

describe("brokerExec happy path", () => {
  it("runs with exactly the REQUESTED (least-privilege) env subset and returns ok", async () => {
    process.env.TOKEN = "t";
    process.env.REGION = "eu";
    process.env.OTHER_SECRET = "leak";
    try {
      let seen: Record<string, string> | undefined;
      const out = await brokerExec(
        CTX({ egressTargets: ["https://api.example.com/x"], envRequested: ["TOKEN"] }),
        POLICY,
        async (env) => {
          seen = env;
          return "done";
        },
      );
      assert.equal(out.ok, true);
      assert.equal(out.result, "done");
      // Least privilege: only the REQUESTED key (TOKEN) is handed to run(), even
      // though REGION is also declared — declaring a key permits it, requesting it
      // provisions it.
      assert.deepEqual(out.scopedEnv, { TOKEN: "t" });
      assert.deepEqual(seen, { TOKEN: "t" });
      assert.equal(seen && "REGION" in seen, false);
      assert.equal(seen && "OTHER_SECRET" in seen, false);
      // authorized (pre-exec) + success (post-exec) entries.
      const lines = auditLines();
      assert.equal(lines.length, 2);
      assert.equal((lines[0].metadata as Record<string, unknown>)?.phase, "authorized");
      assert.equal(lines[1].success, true);
    } finally {
      delete process.env.TOKEN;
      delete process.env.REGION;
      delete process.env.OTHER_SECRET;
    }
  });

  it("audits failure and returns reason when run() throws", async () => {
    const out = await brokerExec(CTX(), POLICY, async () => {
      throw new Error("boom");
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "boom");
    assert.equal(auditLines().at(-1)?.success, false);
  });

  it("composes with a runGoverned-shaped inner run (round-trips result)", async () => {
    type Governed<T> = { ok: boolean; result?: T; reason?: string };
    const fakeRunGoverned = async (): Promise<Governed<number>> => ({ ok: true, result: 42 });
    const out = await brokerExec(CTX(), POLICY, () =>
      fakeRunGoverned().then((o) =>
        o.ok ? (o.result as number) : Promise.reject(new Error(o.reason)),
      ),
    );
    assert.equal(out.ok, true);
    assert.equal(out.result, 42);
  });
});

describe("brokerExec symlink hardening (impure realpath check)", () => {
  it("denies a write through a symlink inside root that escapes root", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-broker-root-"));
    const outside = mkdtempSync(join(tmpdir(), "kit-broker-out-"));
    try {
      symlinkSync(outside, join(root, "escape")); // root/escape -> outside
      const policy: BrokerPolicy = { ...POLICY, fs: { root } };
      let ran = false;
      const out = await brokerExec(CTX({ fsWrites: ["escape/evil.txt"] }), policy, async () => {
        ran = true;
        return 1;
      });
      // Pure string check would ALLOW (escape/ is lexically under root); the
      // realpath check catches that root/escape actually resolves outside root.
      assert.equal(out.ok, false);
      assert.equal(ran, false);
      assert.match(out.denials?.join(" ") ?? "", /escapes root|realpath/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("allows a write to a not-yet-existing path genuinely under root", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-broker-root2-"));
    try {
      const policy: BrokerPolicy = { ...POLICY, fs: { root } };
      const out = await brokerExec(CTX({ fsWrites: ["sub/new.txt"] }), policy, async () => "ok");
      assert.equal(out.ok, true);
      assert.equal(out.result, "ok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runBrokered opt-in (policy file present/absent)", () => {
  const prev = process.env.KIT_EXEC_BROKER_POLICY;
  after(() => {
    if (prev === undefined) delete process.env.KIT_EXEC_BROKER_POLICY;
    else process.env.KIT_EXEC_BROKER_POLICY = prev;
  });

  it("NOT configured (no policy file) → runs unmediated, no default-deny", async () => {
    delete process.env.KIT_EXEC_BROKER_POLICY; // sandbox cwd has no .kit-exec-broker.json
    let ran = false;
    const out = await runBrokered(
      CTX({ egressTargets: ["https://anything.example"] }),
      async () => {
        ran = true;
        return "ok";
      },
    );
    assert.equal(out.ok, true, "passthrough when broker is not opted into");
    assert.equal(out.result, "ok");
    assert.equal(ran, true);
  });

  it("configured with a valid policy → enforces (denies out-of-allowlist egress)", async () => {
    const pol = join(sandbox, "broker.json");
    writeFileSync(
      pol,
      JSON.stringify({
        egress: { allow: ["api.example.com"] },
        fs: { root: sandbox },
        env: { declared: [] },
      }),
    );
    process.env.KIT_EXEC_BROKER_POLICY = pol;
    let ran = false;
    const out = await runBrokered(CTX({ egressTargets: ["https://evil.com"] }), async () => {
      ran = true;
      return 1;
    });
    assert.equal(out.ok, false);
    assert.equal(ran, false, "gate denied before running");
  });

  it("configured but MALFORMED policy → fail-closed deny (never silently off)", async () => {
    const pol = join(sandbox, "broker-bad.json");
    writeFileSync(pol, "{ not valid json");
    process.env.KIT_EXEC_BROKER_POLICY = pol;
    let ran = false;
    const out = await runBrokered(CTX(), async () => {
      ran = true;
      return 1;
    });
    assert.equal(out.ok, false, "a broken policy fails closed, not open");
    assert.equal(ran, false);
  });
});

describe("brokerExec is offline", () => {
  it("succeeds even if global fetch is stubbed to throw (zero egress)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("network access attempted");
    }) as typeof fetch;
    try {
      const out = await brokerExec(CTX(), POLICY, async () => "ok");
      assert.equal(out.ok, true);
      assert.equal(out.result, "ok");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
