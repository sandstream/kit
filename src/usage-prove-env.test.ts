/** The env-write gate controls, run against the real CLI. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { controlEnvWriteGate, type RunKit } from "./usage-prove-env.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "cli.js");

const runKit: RunKit = (args, opts = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    input: opts.input,
    encoding: "utf-8",
    env: { ...process.env, KIT_HIDE_HOOK_SKIP_BANNER: "1", KIT_AUDIT_ANCHOR: "0" },
    timeout: 60_000,
  });
  return { code: r.status ?? 1 };
};

describe("the env-write gate controls", () => {
  it("refuse a plaintext secret written to .env, and allow a harmless write", () => {
    const [refuse, allow] = controlEnvWriteGate(runKit);
    assert.equal(refuse.verdict, "refused", refuse.observed);
    assert.equal(refuse.ok, true);
    assert.equal(allow.verdict, "allowed", allow.observed);
    assert.equal(allow.ok, true);
  });

  it("report a gate that lets the secret through as not ok", () => {
    const [refuse] = controlEnvWriteGate(() => ({ code: 0 }));
    assert.equal(refuse.ok, false);
    assert.equal(refuse.verdict, "allowed");
  });

  it("report a gate that refuses everything as not ok on the allow control", () => {
    const [, allow] = controlEnvWriteGate(() => ({ code: 2 }));
    assert.equal(allow.ok, false);
  });
});
