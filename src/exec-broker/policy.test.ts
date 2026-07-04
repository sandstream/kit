import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadBrokerPolicy, brokerPolicyPath, BROKER_POLICY_ENV } from "./policy.js";

const VALID = {
  egress: { allow: ["api.example.com"] },
  fs: { root: "/repo" },
  env: { declared: ["TOKEN"] },
};

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "kit-broker-policy-"));
}

afterEach(() => {
  delete process.env[BROKER_POLICY_ENV];
});

describe("brokerPolicyPath", () => {
  it("prefers the explicit override arg", () => {
    process.env[BROKER_POLICY_ENV] = "/from/env.json";
    assert.equal(brokerPolicyPath("/from/arg.json"), resolve("/from/arg.json"));
  });

  it("falls back to the KIT_EXEC_BROKER_POLICY env var", () => {
    process.env[BROKER_POLICY_ENV] = "/from/env.json";
    assert.equal(brokerPolicyPath(), resolve("/from/env.json"));
  });

  it("defaults to .kit-exec-broker.json under cwd", () => {
    delete process.env[BROKER_POLICY_ENV];
    assert.equal(brokerPolicyPath(), resolve(process.cwd(), ".kit-exec-broker.json"));
  });
});

describe("loadBrokerPolicy", () => {
  it("returns null when the file is absent (fail-closed)", () => {
    const dir = tmp();
    try {
      assert.equal(loadBrokerPolicy(join(dir, "nope.json")), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads and validates a well-formed policy", () => {
    const dir = tmp();
    try {
      const p = join(dir, "p.json");
      writeFileSync(p, JSON.stringify(VALID));
      const loaded = loadBrokerPolicy(p);
      assert.deepEqual(loaded, VALID);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors the env override for the path", () => {
    const dir = tmp();
    try {
      const p = join(dir, "env.json");
      writeFileSync(p, JSON.stringify(VALID));
      process.env[BROKER_POLICY_ENV] = p;
      assert.deepEqual(loadBrokerPolicy(), VALID);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null on malformed JSON (fail-closed)", () => {
    const dir = tmp();
    try {
      const p = join(dir, "bad.json");
      writeFileSync(p, "{ not json");
      assert.equal(loadBrokerPolicy(p), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null on wrong-typed fields (strict validation)", () => {
    const dir = tmp();
    try {
      const cases = [
        { egress: { allow: "nope" }, fs: { root: "/r" }, env: { declared: [] } },
        { egress: { allow: [] }, fs: { root: "" }, env: { declared: [] } },
        { egress: { allow: [] }, fs: { root: "/r" }, env: { declared: [1] } },
        { egress: { allow: [1] }, fs: { root: "/r" }, env: { declared: [] } },
        { fs: { root: "/r" }, env: { declared: [] } }, // missing egress
        { egress: { allow: [] }, env: { declared: [] } }, // missing fs
        { egress: { allow: [] }, fs: { root: "/r" } }, // missing env
        [],
        "string",
        42,
      ];
      cases.forEach((c, i) => {
        const p = join(dir, `c${i}.json`);
        writeFileSync(p, JSON.stringify(c));
        assert.equal(loadBrokerPolicy(p), null, `case ${i} should be null`);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts empty allow/declared arrays (valid, just deny-all egress)", () => {
    const dir = tmp();
    try {
      const p = join(dir, "empty.json");
      const pol = { egress: { allow: [] }, fs: { root: "/repo" }, env: { declared: [] } };
      writeFileSync(p, JSON.stringify(pol));
      assert.deepEqual(loadBrokerPolicy(p), pol);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
