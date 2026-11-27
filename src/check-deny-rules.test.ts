/**
 * The `deny rule liveness` row (kit-research prismor-always-allowed-rules-vs-kit, Measurement §2):
 * deleting five of kit's deny rules and adding three allows to settings.local.json used to change
 * no `kit check` row.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  KIT_DENY_RULES,
  denyRulesMarkerPath,
  installStrictSettings,
} from "./agent-config-strict.js";
import { checkKitDenyRules } from "./check-deny-rules.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const REMOVED = [
  "Read(~/.ssh/**)",
  "Bash(git push *--force*)",
  "Bash(git push -f*)",
  "Bash(git push * -f*)",
  "Bash(git push * +*)",
];
const LOCAL_ALLOWS = [
  "Bash(curl https://api.internal.example.com/*)",
  "Read(~/.ssh/**)",
  "Bash(git push:*)",
];

function project(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-deny-rules-"));
  t.after(() => rmTemp(dir));
  mkdirSync(join(dir, ".claude"), { recursive: true });
  return dir;
}

function writeJson(dir: string, name: string, value: unknown): void {
  writeFileSync(join(dir, ".claude", name), JSON.stringify(value, null, 2));
}

/** A checkout as `kit agent-config` leaves it: its deny-rules marker and all twelve deny rules. */
function setUp(dir: string, deny: string[] = [...KIT_DENY_RULES]): void {
  writeFileSync(join(dir, ".claude", ".kit-deny-rules-installed"), "2026-11-27T00:00:00Z\n");
  writeJson(dir, "settings.json", { permissions: { deny } });
}

describe("deny rule liveness row", () => {
  it("skips a checkout without kit deny rules, even with gates from kit setup", async (t) => {
    const dir = project(t);
    assert.equal((await checkKitDenyRules(dir)).status, "skip");
    writeFileSync(join(dir, ".claude", ".kit-gates-installed"), "x\n");
    assert.equal((await checkKitDenyRules(dir)).status, "skip");
  });

  it("passes with all twelve rules, and names an inert overriding allow", async (t) => {
    const dir = project(t);
    setUp(dir);
    assert.equal((await checkKitDenyRules(dir)).status, "pass");
    writeJson(dir, "settings.local.json", { permissions: { allow: ["Bash(git push:*)"] } });
    const r = await checkKitDenyRules(dir);
    assert.equal(r.status, "pass");
    assert.match(r.detail, /allows Bash\(git push:\*\), inert while the deny rules stay/);
  });

  it("fails on the measured removal, naming each rule, the live allows and the repair", async (t) => {
    const dir = project(t);
    setUp(
      dir,
      KIT_DENY_RULES.filter((r) => !REMOVED.includes(r)),
    );
    writeJson(dir, "settings.local.json", { permissions: { allow: LOCAL_ALLOWS } });
    const r = await checkKitDenyRules(dir);
    assert.equal(r.status, "fail");
    assert.equal(r.severity, "high");
    for (const rule of REMOVED) assert.ok(r.detail.includes(rule), rule);
    assert.match(
      r.detail,
      /settings\.local\.json allows Read\(~\/\.ssh\/\*\*\), Bash\(git push:\*\)$/,
    );
    assert.match(r.suggestion ?? "", /^Run: kit agent-config/);
  });

  it("applies without the marker once settings.json holds any kit rule, and fails closed", async (t) => {
    const dir = project(t);
    writeJson(dir, "settings.json", { permissions: { deny: ["Read(.env)"] } });
    const r = await checkKitDenyRules(dir);
    assert.equal(r.status, "fail");
    assert.match(r.detail, /^11 of kit's deny rule\(s\) missing/);
    writeFileSync(join(dir, ".claude", ".kit-deny-rules-installed"), "x\n");
    writeFileSync(join(dir, ".claude", "settings.json"), "{ not json");
    assert.match((await checkKitDenyRules(dir)).detail, /does not parse/);
  });

  it("passes again after the repair `kit agent-config` runs (installStrictSettings)", async (t) => {
    const dir = project(t);
    setUp(
      dir,
      KIT_DENY_RULES.filter((r) => !REMOVED.includes(r)),
    );
    assert.equal((await checkKitDenyRules(dir)).status, "fail");
    await installStrictSettings(dir, "linux");
    assert.ok(existsSync(denyRulesMarkerPath(dir)), "the install leaves its marker");
    const deny = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf-8"))
      .permissions.deny as string[];
    assert.equal(deny.length, KIT_DENY_RULES.length);
    assert.equal((await checkKitDenyRules(dir)).status, "pass");
  });
});
