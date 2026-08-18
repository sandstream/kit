import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUserInitDefaults, resolveInitServices } from "./user-defaults.js";
import type { DetectedStack } from "./stack-detector.js";

// User-level init defaults (~/.kit/defaults.toml [init] known_services) — the services the
// operator uses, offered as candidates for a new project. These tests pin two contracts:
// the fail-safe one (a missing/malformed file or unknown id degrades to "no defaults",
// never a crash, and unknown ids are reported rather than dropped), and the one that
// replaced the old behaviour — a known service is never applied to a repo that does not
// reference it, because being the operator's own list does not make it true of this repo.

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
      assert.deepEqual(loadUserInitDefaults(), { services: [], unknown: [], legacyKey: false });
      const s = stack(["stripe"]);
      const r = resolveInitServices(s);
      assert.equal(r.stack, s, "stack object must pass through untouched");
      assert.deepEqual(r.offered, []);
      assert.deepEqual(r.applied, []);
    }));

  it("reads known_services and reports unknown ids — never silently drops", () =>
    withDefaultsFile(`[init]\nknown_services = ["sentry", "posthog", "not-a-service"]\n`, () => {
      const d = loadUserInitDefaults();
      assert.deepEqual(d.services, ["sentry", "posthog"]);
      assert.deepEqual(d.unknown, ["not-a-service"]);
      assert.equal(d.legacyKey, false);
    }));

  it("OFFERS known services instead of adding them to a repo that lacks them", () =>
    withDefaultsFile(`[init]\nknown_services = ["sentry", "posthog"]\n`, () => {
      const r = resolveInitServices(stack(["stripe"]));
      assert.deepEqual(r.stack.services, ["stripe"], "the written config gets detection only");
      assert.deepEqual(r.offered, ["sentry", "posthog"], "the rest are candidates");
      assert.deepEqual(r.applied, [], "nothing is applied without an answer");
    }));

  it("does not offer a service the repo already evidences", () =>
    withDefaultsFile(`[init]\nknown_services = ["sentry"]\n`, () => {
      const r = resolveInitServices(stack(["sentry"]));
      assert.deepEqual(r.stack.services, ["sentry"]);
      assert.deepEqual(r.offered, [], "already detected — nothing left to ask about");
    }));

  it("an explicit choice replaces the selection outright, including the empty one", () =>
    withDefaultsFile(`[init]\nknown_services = ["sentry", "posthog"]\n`, () => {
      const picked = resolveInitServices(stack(["stripe"]), ["stripe", "sentry"]);
      assert.deepEqual(picked.stack.services, ["stripe", "sentry"]);
      assert.deepEqual(picked.applied, ["sentry"], "chosen beyond what was detected");
      assert.deepEqual(picked.offered, [], "nothing outstanding once answered");

      // `--services ""` is a real answer: this project uses none of them, not even the
      // detected ones. It must not fall back to detection.
      const none = resolveInitServices(stack(["stripe"]), []);
      assert.deepEqual(none.stack.services, []);
    }));

  it("an explicit choice kit does not know is reported, not written", () =>
    withDefaultsFile(null, () => {
      const r = resolveInitServices(stack([]), ["stripe", "not-a-service"]);
      assert.deepEqual(r.stack.services, ["stripe"]);
      assert.deepEqual(r.unknown, ["not-a-service"]);
    }));

  it("still reads the old `services` key, and flags it as legacy", () =>
    withDefaultsFile(`[init]\nservices = ["sentry"]\n`, () => {
      const d = loadUserInitDefaults();
      assert.deepEqual(d.services, ["sentry"]);
      assert.equal(d.legacyKey, true, "caller tells the user to rename the key");
      // Same behaviour as the new key: offered, never applied.
      assert.deepEqual(resolveInitServices(stack([])).offered, ["sentry"]);
    }));

  it("malformed toml or wrong shape degrades to no defaults — init must never break", () =>
    withDefaultsFile(`[init\nservices = broken`, () => {
      assert.deepEqual(loadUserInitDefaults(), { services: [], unknown: [], legacyKey: false });
    }));

  it("non-string entries are ignored, not crashed on", () =>
    withDefaultsFile(`[init]\nknown_services = ["sentry", 42, true]\n`, () => {
      assert.deepEqual(loadUserInitDefaults().services, ["sentry"]);
    }));
});
