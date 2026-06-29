import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluatePolicy, versionGte } from "./policy-check.js";
import {
  getPolicyPath,
  getPolicySigPath,
  canonicalPolicyBytes,
  policyFingerprint,
} from "./policy-doc.js";
import { loadOrCreateIdentity, signWithIdentity } from "./identity.js";

describe("policy-check — versionGte", () => {
  it("compares dotted numeric versions", () => {
    assert.equal(versionGte("2.2.0", "2.2.0"), true);
    assert.equal(versionGte("2.3.0", "2.2.0"), true);
    assert.equal(versionGte("2.10.0", "2.2.0"), true);
    assert.equal(versionGte("2.1.9", "2.2.0"), false);
    assert.equal(versionGte("2.2.0", "2.10.0"), false);
  });
});

describe("policy-check — evaluatePolicy", () => {
  let idDir: string;
  const prev = process.env.KIT_IDENTITY_DIR;
  before(() => {
    idDir = mkdtempSync(join(tmpdir(), "kit-pc-id-"));
    process.env.KIT_IDENTITY_DIR = idDir;
    loadOrCreateIdentity(); // so signatures resolve against a known local key
  });
  after(() => {
    if (prev === undefined) delete process.env.KIT_IDENTITY_DIR;
    else process.env.KIT_IDENTITY_DIR = prev;
    rmSync(idDir, { recursive: true, force: true });
  });

  function repo(): string {
    return mkdtempSync(join(tmpdir(), "kit-pc-"));
  }
  function writePolicy(root: string, toml: string): void {
    writeFileSync(getPolicyPath(root), toml);
  }
  function sign(root: string, doc: unknown): void {
    const { identity } = loadOrCreateIdentity();
    const rec = {
      kid: identity.id,
      sig: signWithIdentity(canonicalPolicyBytes(doc)).toString("base64"),
      ts: "t",
      fingerprint: policyFingerprint(doc),
    };
    writeFileSync(getPolicySigPath(root), JSON.stringify(rec));
  }

  it("absent policy → present:false, ok", async () => {
    const root = repo();
    try {
      assert.deepEqual(await evaluatePolicy(root), { present: false, items: [], ok: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("signed policy with a satisfiable min_kit_version passes (sig verifies)", async () => {
    const root = repo();
    try {
      const doc = { version: 1, min_kit_version: "0.0.1" };
      writePolicy(root, 'version = 1\nmin_kit_version = "0.0.1"\n');
      sign(root, doc);
      const r = await evaluatePolicy(root);
      assert.equal(r.signature?.status, "pass", JSON.stringify(r.signature));
      assert.equal(r.items.find((i) => i.requirement === "min_kit_version")?.status, "pass");
      assert.equal(r.ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("unmet min_kit_version is a hard fail", async () => {
    const root = repo();
    try {
      writePolicy(root, 'version = 1\nmin_kit_version = "9999.0.0"\n');
      sign(root, { version: 1, min_kit_version: "9999.0.0" });
      const r = await evaluatePolicy(root);
      assert.equal(r.items.find((i) => i.requirement === "min_kit_version")?.status, "fail");
      assert.equal(r.ok, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a missing required scanner is a warn (non-strict) but a fail under strict", async () => {
    const root = repo();
    try {
      writePolicy(root, 'version = 1\nrequired_scanners = ["definitely-not-a-real-scanner-xyz"]\n');
      sign(root, { version: 1, required_scanners: ["definitely-not-a-real-scanner-xyz"] });
      const lax = await evaluatePolicy(root);
      const laxItem = lax.items.find((i) => i.requirement.startsWith("scanner:"));
      assert.equal(laxItem?.status, "warn");
      assert.equal(lax.ok, true);
      const strict = await evaluatePolicy(root, { strict: true });
      assert.equal(strict.items.find((i) => i.requirement.startsWith("scanner:"))?.status, "fail");
      assert.equal(strict.ok, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a tampered policy (sig no longer matches) is a hard fail", async () => {
    const root = repo();
    try {
      writePolicy(root, "version = 1\nrequire_triage = true\n");
      sign(root, { version: 1, require_triage: true });
      // edit the policy AFTER signing → signature no longer verifies
      writePolicy(root, "version = 1\nrequire_triage = false\n");
      const r = await evaluatePolicy(root);
      assert.equal(r.signature?.status, "fail");
      assert.equal(r.ok, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
