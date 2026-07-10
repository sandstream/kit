import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { triageVaultConfig, classifyBackend } from "./vault-triage.js";
import type { SecretsConfig } from "./config.js";

describe("classifyBackend", () => {
  it("classifies vault-backed / local-plaintext / unknown", () => {
    assert.equal(classifyBackend("1password"), "vault-backed");
    assert.equal(classifyBackend("vault"), "vault-backed");
    assert.equal(classifyBackend("env"), "local-plaintext");
    assert.equal(classifyBackend("dotenvx"), "local-plaintext");
    assert.equal(classifyBackend("nope-store"), "unknown");
  });
});

describe("triageVaultConfig", () => {
  it("passes a vault-backed store + keys and labels assurance", () => {
    const secrets: SecretsConfig = {
      store: "1password",
      keys: { DATABASE_URL: { source: "vault" } },
    };
    const r = triageVaultConfig(secrets);
    assert.equal(r.passed, true);
    assert.equal(r.findings[0].scope, "store"); // store sorted first
    assert.equal(r.findings[0].assurance, "vault-backed");
    assert.equal(r.findings[1].scope, "key:DATABASE_URL");
  });

  it("FAILS on an unknown/typo backend id (silently no vault)", () => {
    const r = triageVaultConfig({ store: "onepassword" } as unknown as SecretsConfig);
    assert.equal(r.passed, false);
    assert.equal(r.findings[0].assurance, "unknown");
    assert.match(r.findings[0].note, /known:/);
  });

  it("surfaces a local/plaintext source but does not fail on it (valid dev choice)", () => {
    const r = triageVaultConfig({ store: "env" });
    assert.equal(r.passed, true);
    assert.equal(r.findings[0].assurance, "local-plaintext");
    assert.match(r.findings[0].note, /prefer a vault backend/);
  });

  it("sorts store first, then keys by name; empty config → passed with no findings", () => {
    const r = triageVaultConfig({
      keys: { ZED: { source: "vault" }, ABLE: { source: "env" } },
    });
    assert.deepEqual(
      r.findings.map((f) => f.scope),
      ["key:ABLE", "key:ZED"],
    );
    const empty = triageVaultConfig(undefined);
    assert.deepEqual(empty.findings, []);
    assert.equal(empty.passed, true);
  });

  it("is pure/deterministic — same config, same result", () => {
    const s: SecretsConfig = { store: "vault", keys: { A: { source: "env" } } };
    assert.deepEqual(triageVaultConfig(s), triageVaultConfig(s));
  });
});
