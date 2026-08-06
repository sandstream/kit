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
import { loadOrCreateIdentity } from "../identity.js";
import { PROFILE_FILE } from "../profile/schema.js";
import { signProfile } from "../profile/sign.js";

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

describe("brokerExec fail-closed on UNDECLARED effects (closes the dead-code false-green)", () => {
  it("denies a gated op that declares NO effect contract, even under a valid policy", async () => {
    let ran = false;
    const out = await brokerExec(CTX(), POLICY, async () => {
      ran = true;
      return 1;
    });
    assert.equal(out.ok, false);
    assert.match(out.reason ?? "", /no effect contract/);
    assert.equal(ran, false);
    assert.equal(auditLines().at(-1)?.success, false);
  });

  it("allows an op that EXPLICITLY declares zero effects (declaredEffects:true)", async () => {
    const out = await brokerExec(CTX({ declaredEffects: true }), POLICY, async () => "ok");
    assert.equal(out.ok, true);
    assert.equal(out.result, "ok");
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
    const out = await brokerExec(CTX({ declaredEffects: true }), POLICY, async () => {
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
    const out = await brokerExec(CTX({ declaredEffects: true }), POLICY, async () => {
      throw new Error("boom");
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "boom");
    assert.equal(auditLines().at(-1)?.success, false);
  });

  it("composes with a runGoverned-shaped inner run (round-trips result)", async () => {
    type Governed<T> = { ok: boolean; result?: T; reason?: string };
    const fakeRunGoverned = async (): Promise<Governed<number>> => ({ ok: true, result: 42 });
    const out = await brokerExec(CTX({ declaredEffects: true }), POLICY, () =>
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

describe("brokerExec multi-root fs (policy.fs.roots)", () => {
  it("allows a write under ANY listed root and denies one under none", async () => {
    const a = mkdtempSync(join(tmpdir(), "kit-broker-a-"));
    const b = mkdtempSync(join(tmpdir(), "kit-broker-b-"));
    const outside = mkdtempSync(join(tmpdir(), "kit-broker-out-"));
    try {
      const policy: BrokerPolicy = { ...POLICY, fs: { root: a, roots: [b] } };
      // under the primary root
      assert.equal(
        (await brokerExec(CTX({ fsWrites: [join(a, "x.txt")] }), policy, async () => 1)).ok,
        true,
      );
      // under the additional root
      assert.equal(
        (await brokerExec(CTX({ fsWrites: [join(b, "y.txt")] }), policy, async () => 1)).ok,
        true,
      );
      // under neither → denied
      const out = await brokerExec(
        CTX({ fsWrites: [join(outside, "z.txt")] }),
        policy,
        async () => 1,
      );
      assert.equal(out.ok, false);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
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

  it("configured + a gated op that declares no effects → fail-closed deny (not dead-code pass)", async () => {
    const pol = join(sandbox, "broker.json");
    writeFileSync(
      pol,
      JSON.stringify({ egress: { allow: [] }, fs: { root: sandbox }, env: { declared: [] } }),
    );
    process.env.KIT_EXEC_BROKER_POLICY = pol;
    let ran = false;
    const out = await runBrokered(CTX(), async () => {
      ran = true;
      return 1;
    });
    assert.equal(out.ok, false);
    assert.match(out.reason ?? "", /no effect contract/);
    assert.equal(ran, false);
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

describe("runBrokered signed-scope runtime enforcement (opt-in via enforce_runtime)", () => {
  const SIGNED_ENFORCED = `version = 1
[scope]
egress = ["api.acme.com"]
enforce_runtime = true
`;

  async function writeSignedProfile(body: string, sign: boolean): Promise<void> {
    loadOrCreateIdentity();
    writeFileSync(join(sandbox, PROFILE_FILE), body);
    if (sign) await signProfile(sandbox);
    delete process.env.KIT_EXEC_BROKER_POLICY; // isolate: the signed path must not depend on JSON
  }

  it("verified scope + declared IN-scope egress → mediates and runs", async () => {
    await writeSignedProfile(SIGNED_ENFORCED, true);
    let ran = false;
    const out = await runBrokered(
      CTX({ egressTargets: ["https://api.acme.com/v1"] }),
      async () => {
        ran = true;
        return "ok";
      },
      { cwd: sandbox },
    );
    assert.equal(out.ok, true);
    assert.equal(ran, true);
  });

  it("verified scope + declared OFF-scope egress → denied, never runs", async () => {
    await writeSignedProfile(SIGNED_ENFORCED, true);
    let ran = false;
    const out = await runBrokered(
      CTX({ egressTargets: ["https://evil.com"] }),
      async () => {
        ran = true;
        return 1;
      },
      { cwd: sandbox },
    );
    assert.equal(out.ok, false);
    assert.equal(ran, false);
  });

  it("verified enforce scope + undeclared op → denied, never runs", async () => {
    await writeSignedProfile(SIGNED_ENFORCED, true);
    let ran = false;
    const out = await runBrokered(
      CTX(),
      async () => {
        ran = true;
        return "ok";
      },
      { cwd: sandbox },
    );
    assert.equal(out.ok, false, "enforce mode must not pass an undeclared op");
    assert.match(out.reason ?? "", /no effect contract/);
    assert.equal(ran, false);
  });

  it("verified enforce scope + explicit zero-effects op → runs", async () => {
    await writeSignedProfile(SIGNED_ENFORCED, true);
    let ran = false;
    const out = await runBrokered(
      CTX({ declaredEffects: true }),
      async () => {
        ran = true;
        return "ok";
      },
      { cwd: sandbox },
    );
    assert.equal(out.ok, true);
    assert.equal(ran, true);
  });

  it("enforce_runtime declared but UNSIGNED → declared op fail-closed denied (policy null)", async () => {
    await writeSignedProfile(SIGNED_ENFORCED, false);
    let ran = false;
    const out = await runBrokered(
      CTX({ egressTargets: ["https://api.acme.com/v1"] }),
      async () => {
        ran = true;
        return 1;
      },
      { cwd: sandbox },
    );
    assert.equal(out.ok, false, "opted into runtime enforcement but scope unsigned → default-deny");
    assert.equal(ran, false);
  });

  it("DEFAULT-ON: a signed scope WITHOUT enforce_runtime observes by default (audits would-deny, never denies)", async () => {
    await writeSignedProfile(`version = 1\n[scope]\negress = ["api.acme.com"]\n`, true);
    let ran = false;
    const out = await runBrokered(
      CTX({ egressTargets: ["https://evil.com"] }), // off-scope: enforce WOULD deny; observe records it
      async () => {
        ran = true;
        return "ok";
      },
      { cwd: sandbox },
    );
    assert.equal(out.ok, true, "observe-by-default never denies");
    assert.equal(ran, true);
    const obs = auditLines().find((l) => (l.metadata as { phase?: string })?.phase === "observe");
    assert.ok(obs, "default-on mediates in observe → an observe audit entry is written");
    const wouldDeny = (obs!.metadata as { wouldDeny?: string[] }).wouldDeny ?? [];
    assert.ok(
      wouldDeny.some((d) => d.includes("evil.com")),
      `the would-be denial is recorded: ${JSON.stringify(wouldDeny)}`,
    );
  });

  it("a CORRUPTED profile denies the declared op — it does not fall back to unmediated", async () => {
    // Regression, found by verifying the README's pillar-3 claim behaviourally: an unreadable
    // profile resolved to runtimeMode "off", and runBrokered skips the broker on "off". So
    // tampering with `.kit-profile.sig` was denied while breaking the TOML syntax ran free —
    // the strictly easier attack had the weaker consequence.
    await writeSignedProfile(`version = 1\n[scope]\negress = ["api.acme.com"]\n`, true);
    writeFileSync(join(sandbox, PROFILE_FILE), `version = 1\n[scope\negress = [`);
    let ran = false;
    const out = await runBrokered(
      CTX({ egressTargets: ["https://api.acme.com/v1"] }), // IN scope, had the scope been readable
      async () => {
        ran = true;
        return 1;
      },
      { cwd: sandbox },
    );
    assert.equal(out.ok, false, "an unreadable RoE must not read as 'no RoE'");
    assert.equal(ran, false, "run() must never be invoked");
    assert.match(
      out.reason ?? "",
      /profile unreadable/,
      `the deny reason names the actual fault: ${out.reason}`,
    );
  });

  it("a corrupted profile denies an UNDECLARED op instead of falling back to unmediated", async () => {
    // A malformed declared RoE is not "off". Once a scope exists but cannot be trusted, the runtime
    // grants nothing until the profile is fixed and re-signed.
    await writeSignedProfile(`version = 1\n[scope]\negress = ["api.acme.com"]\n`, true);
    writeFileSync(join(sandbox, PROFILE_FILE), `version = 1\n[scope\n`);
    let ran = false;
    const out = await runBrokered(
      CTX(),
      async () => {
        ran = true;
        return "ok";
      },
      { cwd: sandbox },
    );
    assert.equal(out.ok, false);
    assert.equal(ran, false);
    assert.match(out.reason ?? "", /profile unreadable/);
  });

  it("observe evidence lands in the GOVERNED project's audit log, not process.cwd()", async () => {
    // Regression: broker audits used to resolve .kit-audit.jsonl from
    // process.cwd(), so an op governed by another project's [scope] — an MCP
    // call with its own cwd, or a test fixture — wrote its observe records
    // into the HOST repo's log and poisoned `kit broker enforce-readiness`
    // there (the first real measurement found 23/23 observed ops were test
    // fixtures). Evidence must follow the project whose scope mediates.
    const project = mkdtempSync(join(tmpdir(), "kit-broker-proj-"));
    try {
      loadOrCreateIdentity();
      writeFileSync(
        join(project, PROFILE_FILE),
        `version = 1\n[scope]\negress = ["api.acme.com"]\n`,
      );
      await signProfile(project);
      delete process.env.KIT_EXEC_BROKER_POLICY;

      // process.cwd() is `sandbox` (see beforeEach) — the governed project differs.
      const out = await runBrokered(
        CTX({ egressTargets: ["https://evil.com"] }),
        async () => "ok",
        { cwd: project },
      );
      assert.equal(out.ok, true, "observe never denies");

      const projLog = join(project, ".kit-audit.jsonl");
      assert.ok(existsSync(projLog), "observe record written to the governed project");
      const projEntries = readFileSync(projLog, "utf-8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { metadata?: { phase?: string } });
      assert.ok(
        projEntries.some((e) => e.metadata?.phase === "observe"),
        "the observe entry is in the project's log",
      );
      assert.ok(
        !auditLines().some((l) => (l.metadata as { phase?: string })?.phase === "observe"),
        "no observe entry leaked into process.cwd()'s log",
      );
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("explicit enforce_runtime = false → runtime OFF (opt out of mediation entirely)", async () => {
    await writeSignedProfile(
      `version = 1\n[scope]\negress = ["api.acme.com"]\nenforce_runtime = false\n`,
      true,
    );
    let ran = false;
    const out = await runBrokered(
      CTX({ egressTargets: ["https://evil.com"] }),
      async () => {
        ran = true;
        return "ok";
      },
      { cwd: sandbox },
    );
    assert.equal(out.ok, true);
    assert.equal(ran, true);
    assert.ok(
      !auditLines().some((l) => (l.metadata as { phase?: string })?.phase === "observe"),
      "explicit off writes no observe audit entry",
    );
  });

  it("infrastructure op under a restrictive enforce_runtime scope → allowed + audited exemption", async () => {
    // fs scope is "src" only, yet an infra op (tool provisioning) is exempt — allowed, and it goes
    // through brokerExec (NOT a silent migration passthrough), leaving an explicit exemption entry.
    await writeSignedProfile(`version = 1\n[scope]\nfs = ["src"]\nenforce_runtime = true\n`, true);
    let ran = false;
    const out = await runBrokered(
      CTX({ infrastructure: true }),
      async () => {
        ran = true;
        return "ok";
      },
      { cwd: sandbox },
    );
    assert.equal(out.ok, true);
    assert.equal(ran, true);
    assert.ok(
      auditLines().some(
        (l) => (l.metadata as { exemption?: string })?.exemption === "infrastructure",
      ),
      "the exemption must be audited explicitly, not silently passed",
    );
  });
});

describe("runBrokered OBSERVE mode (Pillar 3 default-on ladder — dry-run)", () => {
  const OBSERVE = `version = 1\n[scope]\negress = ["api.acme.com"]\nenforce_runtime = "observe"\n`;

  async function writeObserve(sign: boolean): Promise<void> {
    loadOrCreateIdentity();
    writeFileSync(join(sandbox, PROFILE_FILE), OBSERVE);
    if (sign) await signProfile(sandbox);
    delete process.env.KIT_EXEC_BROKER_POLICY;
  }

  const observeLine = () =>
    auditLines().find((l) => (l.metadata as { phase?: string })?.phase === "observe");

  it("OFF-scope egress → still RUNS (never denies) but records the would-be denial", async () => {
    await writeObserve(true);
    let ran = false;
    const out = await runBrokered(
      CTX({ egressTargets: ["https://evil.com"] }),
      async () => {
        ran = true;
        return "ok";
      },
      { cwd: sandbox },
    );
    assert.equal(out.ok, true, "observe must never deny");
    assert.equal(ran, true);
    const obs = observeLine();
    assert.ok(obs, "an observe audit entry must be written");
    const wouldDeny = (obs!.metadata as { wouldDeny?: string[] }).wouldDeny ?? [];
    assert.ok(
      wouldDeny.some((d) => d.includes("evil.com")),
      `would-be denial must be recorded: ${JSON.stringify(wouldDeny)}`,
    );
  });

  it("IN-scope egress → runs with an empty would-deny (clean, ready to enforce)", async () => {
    await writeObserve(true);
    const out = await runBrokered(
      CTX({ egressTargets: ["https://api.acme.com/v1"] }),
      async () => "ok",
      { cwd: sandbox },
    );
    assert.equal(out.ok, true);
    assert.deepEqual((observeLine()!.metadata as { wouldDeny?: string[] }).wouldDeny, []);
  });

  it("UNDECLARED op → still RUNS, but records the enforce denial", async () => {
    await writeObserve(true);
    let ran = false;
    const out = await runBrokered(
      CTX(),
      async () => {
        ran = true;
        return "ok";
      },
      { cwd: sandbox },
    );
    assert.equal(out.ok, true, "observe must not deny undeclared ops");
    assert.equal(ran, true);
    const wouldDeny = (observeLine()!.metadata as { wouldDeny?: string[] }).wouldDeny ?? [];
    assert.ok(
      wouldDeny.some((d) => d.includes("no effect contract")),
      `undeclared observe must not look ready: ${JSON.stringify(wouldDeny)}`,
    );
  });

  it("UNSIGNED observe scope → runs, but records the default-deny that enforce would apply", async () => {
    await writeObserve(false);
    let ran = false;
    const out = await runBrokered(
      CTX({ egressTargets: ["https://api.acme.com/v1"] }),
      async () => {
        ran = true;
        return "ok";
      },
      { cwd: sandbox },
    );
    assert.equal(out.ok, true, "observe never denies, even on an unsigned scope");
    assert.equal(ran, true);
    const wouldDeny = (observeLine()!.metadata as { wouldDeny?: string[] }).wouldDeny ?? [];
    assert.ok(
      wouldDeny.some((d) => d.includes("default-deny")),
      `unsigned observe must record the default-deny: ${JSON.stringify(wouldDeny)}`,
    );
  });
});

describe("brokerExec infrastructure exemption", () => {
  it("runs an infrastructure op even when policy is null (RoE does not govern it)", async () => {
    let ran = false;
    const out = await brokerExec(CTX({ infrastructure: true }), null, async () => {
      ran = true;
      return 1;
    });
    assert.equal(out.ok, true, "a null policy default-denies every NON-infra op; infra is exempt");
    assert.equal(ran, true);
  });

  it("bypasses the resource gates a non-infra op would be denied by, and audits the exemption", async () => {
    const denyAll: BrokerPolicy = {
      egress: { allow: [] },
      fs: { root: sandbox },
      env: { declared: [] },
    };
    let ran = false;
    const out = await brokerExec(
      CTX({ infrastructure: true, egressTargets: ["https://evil.com"] }),
      denyAll,
      async () => {
        ran = true;
        return "ok";
      },
    );
    assert.equal(out.ok, true, "off-scope egress is bypassed for an infrastructure op");
    assert.equal(ran, true);
    assert.ok(
      auditLines().some(
        (l) => (l.metadata as { exemption?: string })?.exemption === "infrastructure",
      ),
    );
  });
});

describe("brokerExec is offline", () => {
  it("succeeds even if global fetch is stubbed to throw (zero egress)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("network access attempted");
    }) as typeof fetch;
    try {
      const out = await brokerExec(CTX({ declaredEffects: true }), POLICY, async () => "ok");
      assert.equal(out.ok, true);
      assert.equal(out.result, "ok");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
