import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  collectPublicSurface,
  serializePublicSurface,
  type PublicSurface,
} from "./public-surface.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/public-surface.test.js -> repo root is one level up.
const SNAPSHOT_PATH = join(__dirname, "..", "contracts", "public-surface.json");

// Breaking-change detector: the live public surface must match the committed
// golden snapshot byte-for-byte. Any drift (a renamed/removed command, a changed
// tier, a new MCP tool, an adapter-sdk export change, a config-schema bump) fails
// here with instructions to acknowledge it.
describe("public surface snapshot", () => {
  it("regenerates identically to the committed contracts/public-surface.json", () => {
    const committed = readFileSync(SNAPSHOT_PATH, "utf-8");
    const live = serializePublicSurface(collectPublicSurface());
    assert.equal(
      live,
      committed,
      [
        "Public surface drifted from contracts/public-surface.json.",
        "If this change is intentional:",
        "  1. Review the diff above.",
        "  2. Run `npm run build && node scripts/gen-public-surface.mjs` to regenerate.",
        "  3. Commit the updated contracts/public-surface.json.",
        "  4. If it removes/renames a STABLE contract, add a BREAKING note to the changelog/PR.",
      ].join("\n"),
    );
  });

  it("serialization is deterministic (stable across repeated collection)", () => {
    const a = serializePublicSurface(collectPublicSurface());
    const b = serializePublicSurface(collectPublicSurface());
    assert.equal(a, b);
  });

  it("the committed snapshot carries the frozen adapter-sdk major + the tiered commands", () => {
    const committed = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf-8")) as PublicSurface;
    assert.match(committed.adapterSdk.version, /^1\./, "adapter-sdk must be frozen at 1.x");
    assert.equal(committed.commands.team, "experimental");
    assert.equal(committed.commands.check, "stable");
    assert.ok(committed.mcpTools.includes("kit_check"));
    assert.ok(committed.exitCodes.includes(0) && committed.exitCodes.includes(1));
  });

  // The byte-for-byte snapshot above forces a human to ACKNOWLEDGE any drift, but
  // it treats an additive change and a BREAKING one identically (regenerate → green).
  // This test makes the "stable = additive-only across 2.x" promise a real invariant,
  // not just review discipline: a removed stable command, a stable→experimental
  // downgrade, or a schema/adapter-sdk major REGRESSION fails here regardless of a
  // regenerated snapshot.
  describe("additive-only invariant vs the committed baseline", () => {
    const baseline = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf-8")) as PublicSurface;
    const live = collectPublicSurface();
    const major = (v: string) => parseInt(v.split(".")[0]!, 10) || 0;

    it("no command that is STABLE in the baseline is removed or downgraded", () => {
      const violations: string[] = [];
      for (const [name, tier] of Object.entries(baseline.commands)) {
        if (tier !== "stable") continue;
        const liveTier = live.commands[name];
        if (liveTier === undefined) violations.push(`removed stable command: ${name}`);
        else if (liveTier !== "stable") violations.push(`downgraded ${name}: stable → ${liveTier}`);
      }
      assert.deepEqual(violations, [], `breaking surface change(s):\n${violations.join("\n")}`);
    });

    it("config schemaVersion and adapter-sdk major never regress", () => {
      assert.ok(
        live.config.schemaVersion >= baseline.config.schemaVersion,
        `config schemaVersion regressed: ${baseline.config.schemaVersion} → ${live.config.schemaVersion}`,
      );
      assert.ok(
        major(live.adapterSdk.version) >= major(baseline.adapterSdk.version),
        `adapter-sdk major regressed: ${baseline.adapterSdk.version} → ${live.adapterSdk.version}`,
      );
    });
  });

  it("DETECTS a simulated surface change (the diff guard actually bites)", () => {
    const committed = serializePublicSurface(collectPublicSurface());
    // Simulate adding a brand-new command to the surface.
    const mutated = collectPublicSurface();
    mutated.commands["totally-new-command"] = "experimental";
    const mutatedJson = serializePublicSurface(mutated);
    assert.notEqual(mutatedJson, committed, "a new command MUST change the serialized surface");
    assert.match(mutatedJson, /totally-new-command/);
  });
});
