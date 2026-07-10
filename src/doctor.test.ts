import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFile, unlink, mkdir, rmdir, rm } from "node:fs/promises";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runDoctor } from "./doctor.js";
import { loadOrCreateIdentity, identityId } from "./identity.js";
import { resolveKeyStore } from "./keystore/index.js";
import {
  loadPolicy,
  canonicalPolicyBytes,
  policyFingerprint,
  getPolicyPath,
  getPolicySigPath,
  type PolicySignature,
} from "./policy-doc.js";
import { addPolicySigner } from "./policy-trust.js";
import { PROFILE_FILE } from "./profile/schema.js";
import { signProfile } from "./profile/sign.js";

describe("runDoctor", () => {
  it("returns skip for Node.js check when no package.json exists", async () => {
    const tmpDir = join(tmpdir(), `kit-doctor-test-${process.pid}-1`);
    await mkdir(tmpDir, { recursive: true });
    try {
      const result = await runDoctor({}, tmpDir);
      const nodeCheck = result.checks.find((c) => c.name === "Node.js version");
      assert.ok(nodeCheck, "Node.js version check should exist");
      assert.equal(nodeCheck.status, "skip");
      assert.ok(
        nodeCheck.detail.includes("No package.json"),
        `unexpected detail: ${nodeCheck.detail}`,
      );
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  it("passes Node.js check when current version satisfies engines.node", async () => {
    const tmpDir = join(tmpdir(), `kit-doctor-test-${process.pid}-2`);
    await mkdir(tmpDir, { recursive: true });
    const pkg = { engines: { node: ">=1.0.0" } }; // extremely low requirement, always passes
    await writeFile(join(tmpDir, "package.json"), JSON.stringify(pkg), "utf-8");
    try {
      const result = await runDoctor({}, tmpDir);
      const nodeCheck = result.checks.find((c) => c.name === "Node.js version");
      assert.ok(nodeCheck, "Node.js version check should exist");
      assert.equal(nodeCheck.status, "pass");
      assert.ok(
        nodeCheck.detail.includes("requires"),
        `detail should mention requirement: ${nodeCheck.detail}`,
      );
    } finally {
      await unlink(join(tmpDir, "package.json"));
      await rmdir(tmpDir);
    }
  });

  it("fails Node.js check when current version does not satisfy engines.node", async () => {
    const tmpDir = join(tmpdir(), `kit-doctor-test-${process.pid}-3`);
    await mkdir(tmpDir, { recursive: true });
    const pkg = { engines: { node: ">=9999.0.0" } }; // impossibly high requirement
    await writeFile(join(tmpDir, "package.json"), JSON.stringify(pkg), "utf-8");
    try {
      const result = await runDoctor({}, tmpDir);
      const nodeCheck = result.checks.find((c) => c.name === "Node.js version");
      assert.ok(nodeCheck, "Node.js version check should exist");
      assert.equal(nodeCheck.status, "fail");
      assert.ok(
        nodeCheck.detail.includes("does not satisfy"),
        `unexpected detail: ${nodeCheck.detail}`,
      );
    } finally {
      await unlink(join(tmpDir, "package.json"));
      await rmdir(tmpDir);
    }
  });

  it("warns about missing .env.local when secrets section is configured", async () => {
    const tmpDir = join(tmpdir(), `kit-doctor-test-${process.pid}-4`);
    await mkdir(tmpDir, { recursive: true });
    try {
      const result = await runDoctor({ secrets: { store: "1password" } }, tmpDir);
      const envCheck = result.checks.find((c) => c.name === ".env.local");
      assert.ok(envCheck, ".env.local check should exist when secrets configured");
      assert.equal(envCheck.status, "warn");
      assert.ok(
        envCheck.detail.includes("kit secrets"),
        `detail should suggest fix: ${envCheck.detail}`,
      );
    } finally {
      await rmdir(tmpDir);
    }
  });

  it("passes .env.local check when file exists and secrets section is configured", async () => {
    const tmpDir = join(tmpdir(), `kit-doctor-test-${process.pid}-5`);
    await mkdir(tmpDir, { recursive: true });
    const envPath = join(tmpDir, ".env.local");
    await writeFile(envPath, "SECRET=value\n", "utf-8");
    try {
      const result = await runDoctor({ secrets: { store: "1password" } }, tmpDir);
      const envCheck = result.checks.find((c) => c.name === ".env.local");
      assert.ok(envCheck, ".env.local check should exist when secrets configured");
      assert.equal(envCheck.status, "pass");
    } finally {
      await unlink(envPath);
      await rmdir(tmpDir);
    }
  });

  it("skips .env.local check when no secrets section", async () => {
    const tmpDir = join(tmpdir(), `kit-doctor-test-${process.pid}-6`);
    await mkdir(tmpDir, { recursive: true });
    try {
      const result = await runDoctor({}, tmpDir);
      const envCheck = result.checks.find((c) => c.name === ".env.local");
      assert.equal(envCheck, undefined, ".env.local check should not run without secrets config");
    } finally {
      await rmdir(tmpDir);
    }
  });

  it("includes mise check in every run", async () => {
    const tmpDir = join(tmpdir(), `kit-doctor-test-${process.pid}-7`);
    await mkdir(tmpDir, { recursive: true });
    try {
      const result = await runDoctor({}, tmpDir);
      const miseCheck = result.checks.find((c) => c.name === "mise");
      assert.ok(miseCheck, "mise check should always be present");
      assert.ok(
        miseCheck.status === "pass" || miseCheck.status === "warn",
        `mise check should be pass or warn, got: ${miseCheck.status}`,
      );
    } finally {
      await rmdir(tmpDir);
    }
  });

  it("correctly counts passed, warnings, and failed", async () => {
    const tmpDir = join(tmpdir(), `kit-doctor-test-${process.pid}-8`);
    await mkdir(tmpDir, { recursive: true });
    // Force a fail via impossible Node.js requirement and a warn via missing .env.local
    const pkg = { engines: { node: ">=9999.0.0" } };
    await writeFile(join(tmpDir, "package.json"), JSON.stringify(pkg), "utf-8");
    try {
      const result = await runDoctor({ secrets: { store: "env" } }, tmpDir);

      const total = result.passed + result.warnings + result.failed;
      const skipped = result.checks.filter((c) => c.status === "skip").length;
      assert.equal(total + skipped, result.checks.length, "counts should sum to total checks");

      assert.ok(result.failed >= 1, "should have at least 1 failure (Node.js version)");
      assert.ok(result.warnings >= 1, "should have at least 1 warning (.env.local missing)");
    } finally {
      await unlink(join(tmpDir, "package.json"));
      await rmdir(tmpDir);
    }
  });

  it("exec-broker runtime: skips when no [scope] is declared (nothing to mediate)", async () => {
    const tmpDir = join(tmpdir(), `kit-doctor-test-${process.pid}-rt-skip`);
    await mkdir(tmpDir, { recursive: true });
    try {
      const result = await runDoctor({}, tmpDir);
      const rt = result.checks.find((c) => c.name === "exec-broker runtime");
      assert.ok(rt, "exec-broker runtime check should always be present");
      assert.equal(rt.status, "skip");
      assert.ok(rt.detail.includes("no [scope]"), `unexpected detail: ${rt.detail}`);
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  it("exec-broker runtime: fails when opted in but the scope is unsigned (fail-closed)", async () => {
    const tmpDir = join(tmpdir(), `kit-doctor-test-${process.pid}-rt-fail`);
    await mkdir(tmpDir, { recursive: true });
    // enforce_runtime declared but the profile is NOT signed → runtime denies governed ops.
    await writeFile(
      join(tmpDir, ".kit-profile.toml"),
      `version = 1\n[scope]\negress = ["api.acme.com"]\nenforce_runtime = true\n`,
      "utf-8",
    );
    try {
      const result = await runDoctor({}, tmpDir);
      const rt = result.checks.find((c) => c.name === "exec-broker runtime");
      assert.ok(rt, "exec-broker runtime check should be present");
      assert.equal(rt.status, "fail");
      assert.ok(
        rt.detail.includes("fail-closed-denied") || rt.detail.includes("unsigned"),
        `detail should explain the fail-closed posture: ${rt.detail}`,
      );
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  it("exec-broker runtime: warns in OBSERVE (dry-run) mode", async () => {
    const tmpDir = join(tmpdir(), `kit-doctor-test-${process.pid}-rt-observe`);
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      join(tmpDir, ".kit-profile.toml"),
      `version = 1\n[scope]\negress = ["api.acme.com"]\nenforce_runtime = "observe"\n`,
      "utf-8",
    );
    try {
      const result = await runDoctor({}, tmpDir);
      const rt = result.checks.find((c) => c.name === "exec-broker runtime");
      assert.ok(rt, "exec-broker runtime check should be present");
      assert.equal(rt.status, "warn");
      assert.ok(rt.detail.includes("OBSERVE"), `detail should name the observe mode: ${rt.detail}`);
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  it("surfaces the identity keystore posture (Pelare 1 — never silent)", async () => {
    const tmpDir = join(tmpdir(), `kit-doctor-test-${process.pid}-9`);
    await mkdir(tmpDir, { recursive: true });
    try {
      const result = await runDoctor({}, tmpDir);
      const ks = result.checks.find((c) => c.name === "identity keystore");
      assert.ok(ks, "identity keystore check should always be present");
      // Backend-dependent, but must be an honest, non-silent verdict.
      assert.ok(
        ["pass", "warn", "fail"].includes(ks.status),
        `identity keystore must report a real posture, got ${ks.status}`,
      );
      assert.ok(ks.detail.length > 0, "identity keystore must explain its posture");
    } finally {
      await rmdir(tmpDir);
    }
  });
});

describe("runDoctor — control plane (org policy) row (Pillar 2 §4.6)", () => {
  let idDir: string;
  let proj: string;
  let savedId: string | undefined;

  beforeEach(() => {
    idDir = mkdtempSync(join(tmpdir(), "kit-id-"));
    proj = mkdtempSync(join(tmpdir(), "kit-cp-"));
    savedId = process.env.KIT_IDENTITY_DIR;
    process.env.KIT_IDENTITY_DIR = idDir;
    loadOrCreateIdentity();
  });

  afterEach(() => {
    if (savedId === undefined) delete process.env.KIT_IDENTITY_DIR;
    else process.env.KIT_IDENTITY_DIR = savedId;
    rmSync(idDir, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  });

  const cpRow = async () =>
    (await runDoctor({}, proj)).checks.find((c) => c.name === "control plane (org policy)");

  it("skips when no org policy is distributed here", async () => {
    const row = await cpRow();
    assert.ok(row);
    assert.equal(row.status, "skip");
  });

  it("warns when an org policy is present but unsigned", async () => {
    writeFileSync(getPolicyPath(proj), "version = 1\n", "utf-8");
    const row = await cpRow();
    assert.ok(row);
    assert.equal(row.status, "warn");
  });

  it("passes for a present + verified org policy (and notes RBAC)", async () => {
    writeFileSync(
      getPolicyPath(proj),
      `version = 1\n[rbac.roles]\ndeployer = ["deploy:prod"]\n\n[[rbac.bindings]]\nkid = "kid_x"\nrole = "deployer"\n`,
      "utf-8",
    );
    const pub = resolveKeyStore().store.publicKeyPem()!;
    const doc = loadPolicy(proj)!;
    const record: PolicySignature = {
      kid: identityId(pub),
      sig: resolveKeyStore().store.sign(canonicalPolicyBytes(doc)).toString("base64"),
      ts: new Date().toISOString(),
      fingerprint: policyFingerprint(doc),
    };
    writeFileSync(getPolicySigPath(proj), JSON.stringify(record, null, 2) + "\n", "utf-8");
    addPolicySigner(proj, pub, "org");

    const row = await cpRow();
    assert.ok(row);
    assert.equal(row.status, "pass", row.detail);
    assert.match(row.detail, /RBAC 1 role/);
  });
});

describe("runDoctor — keyless credentials row (Pillar 2 tail)", () => {
  let idDir: string;
  let proj: string;
  let savedId: string | undefined;

  beforeEach(() => {
    idDir = mkdtempSync(join(tmpdir(), "kit-id-"));
    proj = mkdtempSync(join(tmpdir(), "kit-kl-"));
    savedId = process.env.KIT_IDENTITY_DIR;
    process.env.KIT_IDENTITY_DIR = idDir;
    loadOrCreateIdentity();
  });

  afterEach(() => {
    if (savedId === undefined) delete process.env.KIT_IDENTITY_DIR;
    else process.env.KIT_IDENTITY_DIR = savedId;
    rmSync(idDir, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  });

  const klRow = async () =>
    (await runDoctor({}, proj)).checks.find((c) => c.name === "keyless credentials");

  it("skips when no [scope].sign hosts are declared", async () => {
    const row = await klRow();
    assert.ok(row);
    assert.equal(row.status, "skip");
  });

  it("fails when keyless hosts are declared but the scope is unverified (fail-closed)", async () => {
    writeFileSync(
      join(proj, PROFILE_FILE),
      `version = 1\n[scope]\nsign = ["api.acme.com"]\n`,
      "utf-8",
    );
    const row = await klRow();
    assert.ok(row);
    assert.equal(row.status, "fail");
    assert.match(row.detail, /unverified|not trusted/);
  });

  it("passes when keyless hosts are declared, the scope is verified, and an identity can sign", async () => {
    writeFileSync(
      join(proj, PROFILE_FILE),
      `version = 1\n[scope]\nsign = ["api.acme.com"]\n`,
      "utf-8",
    );
    await signProfile(proj);
    const row = await klRow();
    assert.ok(row);
    assert.equal(row.status, "pass", row.detail);
    assert.match(row.detail, /require signed requests/);
  });
});
