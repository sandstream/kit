import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeProfileDrift, discoverActualState, type DiscoveredState } from "./reconcile.js";
import type { KitProfile } from "./schema.js";

function profile(over: Partial<KitProfile> = {}): KitProfile {
  return { version: 1, generated: "1970-01-01T00:00:00.000Z", ...over };
}

function actual(over: Partial<DiscoveredState> = {}): DiscoveredState {
  return { skills: [], mcp: [], workflows: null, plugins: null, ...over };
}

describe("computeProfileDrift", () => {
  it("is clean when declared matches discovered exactly", () => {
    const d = computeProfileDrift(
      profile({ skills: [{ name: "api-test", version: "1.4.0" }] }),
      actual({ skills: [{ name: "api-test", version: "1.4.0" }] }),
    );
    assert.equal(d.clean, true);
    assert.equal(d.driftCount, 0);
    assert.equal(d.entries[0]?.status, "in-sync");
  });

  it("flags a declared-but-absent component as removed", () => {
    const d = computeProfileDrift(
      profile({ skills: [{ name: "legacy", version: "1.0.0" }] }),
      actual({ skills: [] }),
    );
    assert.equal(d.clean, false);
    assert.equal(d.driftCount, 1);
    assert.deepEqual(d.entries, [
      { kind: "skill", name: "legacy", status: "removed", declared: "1.0.0" },
    ]);
  });

  it("flags a present-but-undeclared component as added", () => {
    const d = computeProfileDrift(profile({ mcp: [] }), actual({ mcp: [{ name: "some-server" }] }));
    assert.equal(d.driftCount, 1);
    assert.deepEqual(d.entries, [
      { kind: "mcp", name: "some-server", status: "added", found: undefined },
    ]);
  });

  it("flags version-drift only when both sides pin a differing version", () => {
    const d = computeProfileDrift(
      profile({ skills: [{ name: "s", version: "1.0.0" }] }),
      actual({ skills: [{ name: "s", version: "2.1.0" }] }),
    );
    assert.equal(d.entries[0]?.status, "version-drift");
    assert.equal(d.entries[0]?.declared, "1.0.0");
    assert.equal(d.entries[0]?.found, "2.1.0");
  });

  it("does not flag drift when the declaration is unpinned", () => {
    const d = computeProfileDrift(
      profile({ skills: [{ name: "s" }] }),
      actual({ skills: [{ name: "s", version: "9.9.9" }] }),
    );
    assert.equal(d.clean, true);
    assert.equal(d.entries[0]?.status, "in-sync");
  });

  it("does not call it drift when the found version is unknown", () => {
    const d = computeProfileDrift(
      profile({ skills: [{ name: "s", version: "1.0.0" }] }),
      actual({ skills: [{ name: "s" }] }),
    );
    assert.equal(d.clean, true);
    assert.equal(d.entries[0]?.status, "in-sync");
  });

  it("reports vault store in-sync / drift / not-declared", () => {
    assert.equal(
      computeProfileDrift(
        profile({ vault: { store: "1password" } }),
        actual({ vaultStore: "1password" }),
      ).vault?.status,
      "in-sync",
    );
    const drift = computeProfileDrift(
      profile({ vault: { store: "1password" } }),
      actual({ vaultStore: "vault" }),
    );
    assert.equal(drift.vault?.status, "drift");
    assert.equal(drift.driftCount, 1);
    assert.equal(computeProfileDrift(profile(), actual()).vault, null);
  });

  it("reports declared-but-undiscoverable kinds as unaudited, not clean-washed", () => {
    const d = computeProfileDrift(
      profile({ workflows: [{ name: "release" }], plugins: [{ name: "p" }] }),
      actual({ workflows: null, plugins: null }),
    );
    assert.deepEqual(d.unaudited, ["workflow", "plugin"]);
    // unaudited kinds must NOT emit drift entries and must NOT make the profile dirty
    assert.equal(d.entries.length, 0);
    assert.equal(d.driftCount, 0);
    assert.equal(d.clean, true);
  });

  it("does not mark a kind unaudited when nothing is declared for it", () => {
    const d = computeProfileDrift(profile(), actual({ workflows: null, plugins: null }));
    assert.deepEqual(d.unaudited, []);
  });

  it("sorts entries by kind, then name, then status — deterministically", () => {
    const p = profile({
      mcp: [{ name: "z-srv" }, { name: "a-srv" }],
      skills: [{ name: "beta" }],
    });
    const a = actual({
      skills: [{ name: "alpha" }], // added (alpha), removed (beta)
      mcp: [{ name: "a-srv" }, { name: "z-srv" }],
    });
    const one = computeProfileDrift(p, a);
    const two = computeProfileDrift(p, a);
    assert.deepEqual(one, two);
    // skills come before mcp; within skills alpha(added) before beta(removed)
    assert.equal(one.entries[0]?.kind, "skill");
    assert.equal(one.entries[0]?.name, "alpha");
    assert.equal(one.entries[1]?.name, "beta");
    assert.equal(one.entries[2]?.kind, "mcp");
  });
});

describe("discoverActualState", () => {
  it("discovers skills + MCP servers + vault store; workflows/plugins remain unknown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-reconcile-"));
    try {
      mkdirSync(join(dir, ".claude/skills/api-test"), { recursive: true });
      writeFileSync(join(dir, ".claude/skills/api-test/SKILL.md"), "# api-test\n");
      writeFileSync(
        join(dir, ".mcp.json"),
        JSON.stringify({ mcpServers: { postgres: { command: "npx x" } } }),
      );
      writeFileSync(join(dir, ".kit.toml"), `[secrets]\nstore = "1password"\n`);

      const state = await discoverActualState(dir);
      assert.deepEqual(
        state.skills.map((s) => s.name),
        ["api-test"],
      );
      assert.deepEqual(
        state.mcp.map((s) => s.name),
        ["postgres"],
      );
      assert.equal(state.vaultStore, "1password");
      assert.equal(state.workflows, null);
      assert.equal(state.plugins, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("degrades to unknown vault store when there is no .kit.toml (never throws)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-reconcile-"));
    try {
      const state = await discoverActualState(dir);
      assert.equal(state.vaultStore, undefined);
      assert.deepEqual(state.skills, []);
      assert.deepEqual(state.mcp, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("feeds computeProfileDrift end-to-end (declared profile vs a real temp project)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-reconcile-"));
    try {
      mkdirSync(join(dir, ".claude/skills/api-test"), { recursive: true });
      writeFileSync(join(dir, ".claude/skills/api-test/SKILL.md"), "# api-test\n");
      const state = await discoverActualState(dir);
      const d = computeProfileDrift(profile({ skills: [{ name: "api-test" }] }), state);
      assert.equal(d.clean, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
