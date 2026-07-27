import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUserInitDefaults, applyUserInitDefaults } from "./user-defaults.js";
import type { DetectedStack } from "./stack-detector.js";

// User-level init defaults (~/.kit/defaults.toml [init] services) — the
// operator's standing preferences, merged by BOTH init surfaces. These tests
// pin the fail-safe contract: a missing/malformed file or unknown id degrades
// to "no defaults", never a crash, and unknown ids are reported, never silent.

function withDefaultsFile(content: string | null, fn: () => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "kit-defaults-"));
  const saved = process.env.KIT_DEFAULTS_FILE;
  const file = join(dir, "defaults.toml");
  if (content !== null) writeFileSync(file, content, "utf-8");
  process.env.KIT_DEFAULTS_FILE = file;
  return Promise.resolve(fn()).finally(() => {
    if (saved === undefined) delete process.env.KIT_DEFAULTS_FILE;
    else process.env.KIT_DEFAULTS_FILE = saved;
    rmSync(dir, { recursive: true, force: true });
  });
}

const stack = (services: string[] = []): DetectedStack => ({
  language: "typescript",
  services,
  tools: {},
  confidence: 0.9,
});

describe("user init defaults", () => {
  it("no defaults file — the common case — yields no defaults and an unchanged stack", () =>
    withDefaultsFile(null, () => {
      assert.deepEqual(loadUserInitDefaults(), { services: [], unknown: [] });
      const s = stack(["stripe"]);
      const r = applyUserInitDefaults(s);
      assert.equal(r.stack, s, "stack object must pass through untouched");
      assert.deepEqual(r.applied, []);
    }));

  it("merges known default services and reports unknown ids — never silently drops", () =>
    withDefaultsFile(`[init]\nservices = ["sentry", "posthog", "not-a-service"]\n`, () => {
      const d = loadUserInitDefaults();
      assert.deepEqual(d.services, ["sentry", "posthog"]);
      assert.deepEqual(d.unknown, ["not-a-service"]);
      const r = applyUserInitDefaults(stack(["stripe"]));
      assert.deepEqual(r.stack.services, ["stripe", "sentry", "posthog"]);
      assert.deepEqual(r.applied, ["sentry", "posthog"]);
      assert.deepEqual(r.unknown, ["not-a-service"]);
    }));

  it("does not duplicate a service the stack already detected", () =>
    withDefaultsFile(`[init]\nservices = ["sentry"]\n`, () => {
      const r = applyUserInitDefaults(stack(["sentry"]));
      assert.deepEqual(r.stack.services, ["sentry"]);
      assert.deepEqual(r.applied, [], "already-detected default is not re-applied");
    }));

  it("malformed toml or wrong shape degrades to no defaults — init must never break", () =>
    withDefaultsFile(`[init\nservices = broken`, () => {
      assert.deepEqual(loadUserInitDefaults(), { services: [], unknown: [] });
    }));

  it("non-string entries are ignored, not crashed on", () =>
    withDefaultsFile(`[init]\nservices = ["sentry", 42, true]\n`, () => {
      assert.deepEqual(loadUserInitDefaults().services, ["sentry"]);
    }));
});
