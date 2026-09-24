import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classify,
  isFailClosed,
  runHeal,
  safeRecipe,
  TriageBlocked,
  type HealDeps,
} from "./heal.js";
import type { SecurityCheckResult } from "./check-security.js";

const r = (over: Partial<SecurityCheckResult>): SecurityCheckResult => ({
  category: "supply-chain",
  name: "x",
  status: "warn",
  detail: "",
  ...over,
});

function loopFixture(
  snapshots: SecurityCheckResult[][],
  apply: () => Promise<void> = async () => {},
): { deps: HealDeps; scans: () => number; attempts: () => number } {
  let scans = 0;
  let attempts = 0;
  return {
    scans: () => scans,
    attempts: () => attempts,
    deps: {
      scan: async () => snapshots[Math.min(scans++, snapshots.length - 1)],
      sync: async () => null,
      recipe: () => async () => {
        attempts++;
        await apply();
      },
    },
  };
}

const repairable = r({
  name: "fixture scanner",
  status: "fail",
  detail: "scanner unavailable",
  suggestion: "mise use fixture:scanner",
});

describe("heal preserves unresolved auto-repair findings", () => {
  it("returns a thrown repair as manual work at the iteration cap", async () => {
    const fixture = loopFixture([[repairable]], async () => {
      throw new Error("repair failed");
    });
    const result = await runHeal({ maxIterations: 1 }, fixture.deps);
    assert.deepEqual(result.healed, []);
    assert.equal(result.gated.length, 1);
    assert.equal(result.gated[0].name, repairable.name);
    assert.equal(fixture.attempts(), 1);
    assert.equal(result.iterations, 1);
    assert.equal(fixture.scans(), 2, "one bounded confirmation scan after the attempt");
  });

  it("does not retry a completed recipe that leaves its finding unresolved", async () => {
    const fixture = loopFixture([[repairable]]);
    const result = await runHeal({ maxIterations: 3 }, fixture.deps);
    assert.deepEqual(result.healed, []);
    assert.equal(result.gated.length, 1);
    assert.equal(fixture.attempts(), 1);
    assert.equal(result.iterations, 2);
    assert.equal(fixture.scans(), 3);
  });

  it("retains a newly discovered safe finding from the final scan", async () => {
    const next = { ...repairable, name: "another scanner" };
    const fixture = loopFixture([[repairable], [next]]);
    const result = await runHeal({ maxIterations: 1 }, fixture.deps);
    assert.deepEqual(result.healed, ["supply-chain:fixture scanner"]);
    assert.deepEqual(
      result.gated.map((finding) => finding.name),
      [next.name],
    );
    assert.equal(fixture.attempts(), 1);
    assert.equal(fixture.scans(), 2);
  });
});

describe("heal preserves success, dry-run, and triage behavior", () => {
  it("reports a repair as healed only when the final scan clears it", async () => {
    const fixture = loopFixture([[repairable], []]);
    const result = await runHeal({ maxIterations: 1 }, fixture.deps);
    assert.deepEqual(result.healed, ["supply-chain:fixture scanner"]);
    assert.deepEqual(result.gated, []);
    assert.equal(fixture.attempts(), 1);
    assert.equal(fixture.scans(), 2);
  });

  it("dry-run keeps safe plans separate from gated and tamper findings", async () => {
    const manual = r({ name: "manual", status: "fail", detail: "rotate exposed credential" });
    const tamper = r({ name: "tamper", status: "fail", detail: "checksum mismatch" });
    const fixture = loopFixture([[repairable, manual, tamper]]);
    const result = await runHeal({ dryRun: true }, fixture.deps);
    assert.deepEqual(result.plannedSafe, ["supply-chain:fixture scanner"]);
    assert.deepEqual(
      result.gated.map((finding) => finding.name),
      [manual.name],
    );
    assert.deepEqual(result.failClosed, [tamper]);
    assert.equal(fixture.attempts(), 0);
    assert.equal(fixture.scans(), 1);
  });

  it("a triage refusal stays manual once, with its reason", async () => {
    const fixture = loopFixture([[repairable]], async () => {
      throw new TriageBlocked("fixture:scanner", "package rejected");
    });
    const result = await runHeal({}, fixture.deps);
    assert.deepEqual(result.healed, []);
    assert.equal(result.gated.length, 1);
    assert.match(result.gated[0].action, /triage: package rejected/);
    assert.equal(fixture.attempts(), 1);
    assert.equal(fixture.scans(), 3);
  });
});

describe("kit heal — classification (safe / gated / fail-closed boundary)", () => {
  it("scanner-missing (suggestion `mise use <ref>`) → safe + has a recipe", () => {
    const f = r({
      name: "socket scan",
      category: "supply-chain",
      status: "warn",
      suggestion: "mise use npm:@socketsecurity/cli  (or: npm install -g @socketsecurity/cli)",
    });
    assert.equal(classify(f), "safe");
    assert.ok(safeRecipe(f));
  });

  it("missing .gitignore pattern → safe", () => {
    const f = r({
      name: ".env gitignored",
      category: "exposure",
      status: "warn",
      detail: ".gitignore not found",
    });
    assert.equal(classify(f), "safe");
    assert.ok(safeRecipe(f));
  });

  it("checksum mismatch → FAIL-CLOSED (never safe, no recipe)", () => {
    const f = r({
      name: "bumblebee (supply-chain)",
      category: "supply-chain",
      status: "fail",
      detail: "scanner cached binary checksum mismatch (expected …, got …)",
      suggestion: "Do NOT trust it. Investigate for tampering (network MITM, compromised mirror).",
    });
    assert.equal(isFailClosed(f), true);
    assert.equal(classify(f), "fail-closed");
    assert.equal(safeRecipe(f), null);
  });

  it("destructive/outward finding → GATED (no safe recipe)", () => {
    const f = r({
      name: "leaked key in history",
      category: "secrets",
      status: "fail",
      detail: "committed secret value",
      suggestion: "kit secrets rotate STRIPE_KEY && kit secrets purge-history",
    });
    assert.equal(classify(f), "gated");
    assert.equal(safeRecipe(f), null);
  });

  it("isFailClosed only fires on a fail carrying a tamper signal", () => {
    assert.equal(isFailClosed(r({ status: "fail", detail: "2 high vulnerabilities" })), false);
    assert.equal(isFailClosed(r({ status: "warn", detail: "checksum mismatch" })), false); // warn, not fail
    assert.equal(isFailClosed(r({ status: "fail", detail: "scanner checksum mismatch" })), true);
  });
});
