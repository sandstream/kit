import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { prepareLaunchPolicy } from "./launch-policy.js";
import { snapshotFixture } from "./snapshot.test-support.js";
import { SEATBELT } from "./launch-profile.js";

const baseline = {
  schema: 1,
  entry: "main.mjs",
  outputDirectory: join(tmpdir(), "fixture"),
  timeoutMs: 3000,
};

it("refuses policy fields and entry paths that the delegate cannot enforce", () => {
  for (const change of [
    { entry: "../main.mjs" },
    { timeoutMs: 0 },
    { timeoutMs: 30_001 },
    { credentials: ["secret"] },
    { network: ["remote.invalid"] },
    { children: true },
    { requiredCheck: "unknown" },
  ]) {
    assert.deepEqual(prepareLaunchPolicy({ ...baseline, ...change }), {
      ok: false,
      reason: "invalid-run-policy",
    });
  }
});

it(
  "refuses to prepare a run when the bound executable is missing",
  {
    skip: process.arch !== "arm64" || process.platform !== "darwin",
  },
  () => {
    const f = snapshotFixture();
    const current = Object.getOwnPropertyDescriptor(process, "execPath")!;
    try {
      Object.defineProperty(process, "execPath", {
        ...current,
        value: join(f.root, "absent-node"),
      });
      assert.deepEqual(prepareLaunchPolicy({ ...baseline, outputDirectory: join(f.root, "out") }), {
        ok: false,
        reason: "run-delegate-unavailable",
      });
    } finally {
      Object.defineProperty(process, "execPath", current);
      f.cleanup();
    }
  },
);

it(
  "refuses when the external sandbox executable is missing",
  {
    skip: process.arch !== "arm64" || process.platform !== "darwin",
  },
  (t) => {
    const original = fs.lstatSync;
    const stat = t.mock.method(fs, "lstatSync", (...args: Parameters<typeof original>) => {
      const [path] = args;
      if (path === SEATBELT)
        throw Object.assign(new Error("missing fixture delegate"), { code: "ENOENT" });
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      assert.deepEqual(prepareLaunchPolicy(baseline), {
        ok: false,
        reason: "run-delegate-unavailable",
      });
    } finally {
      stat.mock.restore();
      syncBuiltinESMExports();
    }
  },
);

it("refuses a valid launch recipe on an unsupported platform", () => {
  const current = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...current, value: "linux" });
    assert.deepEqual(prepareLaunchPolicy(baseline), {
      ok: false,
      reason: "run-platform-unsupported",
    });
  } finally {
    Object.defineProperty(process, "platform", current);
  }
});
