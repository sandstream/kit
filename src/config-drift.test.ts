/**
 * The two ways a `.kit.toml` falls behind, and the readers that were missing.
 *
 * Schema drift had a working detector — `kit config migrate --check` answers it — and no caller,
 * so `kit status` said `✓ .kit.toml present` and never that "present" is not "current". Measured
 * on kit's own repo: v0 while the schema was v1, unreported (#511).
 *
 * Feature drift had no detector at all. `applyRecommendedHardening()` knew the recommended
 * posture and was reachable only from `kit setup`, which APPLIES it — touching `~/.claude`,
 * `~/.codex` and the repo's git hooks — so asking "what would I get?" meant letting it happen.
 *
 * Both readers are asserted here on the property that makes them worth having: a row that states
 * what the piece BUYS rather than that it is missing, and a planner that answers without writing.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { planConfigMigration } from "./config-migrate.js";
import { recommendPosture } from "./recommended.js";
import { CONFIG_SCHEMA_VERSION } from "./config.js";

const CLI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");

function repoWith(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-drift-"));
  writeFileSync(join(dir, ".kit.toml"), toml);
  return dir;
}

describe("planConfigMigration — the detector, without a write path", () => {
  it("reports a legacy config as behind, naming both versions", () => {
    const dir = repoWith('[tools]\nnode = "22"\n');
    try {
      const plan = planConfigMigration(dir);
      assert.ok(plan);
      assert.equal(plan.fromVersion, 0, "no version stamp is legacy v0");
      assert.equal(plan.toVersion, CONFIG_SCHEMA_VERSION);
      assert.equal(plan.current, false);
      assert.ok(plan.steps > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a stamped config as current", () => {
    const dir = repoWith(`version = ${CONFIG_SCHEMA_VERSION}\n[tools]\nnode = "22"\n`);
    try {
      const plan = planConfigMigration(dir);
      assert.equal(plan?.current, true);
      assert.equal(plan?.steps, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null rather than guessing when there is no readable config", () => {
    const empty = mkdtempSync(join(tmpdir(), "kit-drift-empty-"));
    const broken = repoWith("this is not toml = = =\n");
    try {
      assert.equal(planConfigMigration(empty), null);
      assert.equal(planConfigMigration(broken), null);
    } finally {
      rmSync(empty, { recursive: true, force: true });
      rmSync(broken, { recursive: true, force: true });
    }
  });

  it("writes nothing — the file is byte-identical afterwards", () => {
    const dir = repoWith('[tools]\nnode = "22"\n');
    try {
      const before = spawnSync("cat", [join(dir, ".kit.toml")], { encoding: "utf-8" }).stdout;
      planConfigMigration(dir);
      const after = spawnSync("cat", [join(dir, ".kit.toml")], { encoding: "utf-8" }).stdout;
      assert.equal(after, before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("recommendPosture — states what each piece buys", () => {
  const probes = { memoryHooks: false, gitHooks: [] as string[] };

  it("marks nothing adopted for a bare config, and every row says what it buys", () => {
    const rows = recommendPosture({}, probes);
    assert.ok(rows.length >= 8);
    for (const r of rows) {
      assert.equal(r.adopted, false, r.key);
      assert.ok(r.buys.length > 30, `${r.key}: a row that only says "missing" gets ignored`);
      assert.ok(r.how, `${r.key}: an unadopted row must say how`);
    }
  });

  it("marks a declared section as adopted and drops its how", () => {
    const rows = recommendPosture(
      { context: { github: { org: "acme" } }, deploy: { required: ["A"] } } as never,
      probes,
    );
    const ctx = rows.find((r) => r.key === "context");
    const deploy = rows.find((r) => r.key === "deploy-env");
    assert.equal(ctx?.adopted, true);
    assert.equal(ctx?.how, undefined);
    assert.equal(deploy?.adopted, true);
  });

  it("tells you to declare [context] before the pre-push gate, not to install a gate that cannot fail", () => {
    const without = recommendPosture({}, probes).find((r) => r.key === "context-check-hook");
    assert.match(without?.how ?? "", /declare \[context\] first/);

    const with_ = recommendPosture({ context: { git: { email: "a@b.c" } } } as never, probes).find(
      (r) => r.key === "context-check-hook",
    );
    assert.match(with_?.how ?? "", /kit hooks add context-check/);
  });

  it("reads installed git hooks and memory hooks as adopted", () => {
    const rows = recommendPosture({}, { memoryHooks: true, gitHooks: ["secret-scan"] });
    assert.equal(rows.find((r) => r.key === "memory-hooks")?.adopted, true);
    assert.equal(rows.find((r) => r.key === "secret-scan")?.adopted, true);
    assert.equal(rows.find((r) => r.key === "post-pull-audit")?.adopted, false);
  });
});

describe("the readers, through the compiled CLI", () => {
  const run = (args: string[], cwd: string): { code: number; out: string; err: string } => {
    const r = spawnSync(process.execPath, [CLI_PATH, ...args], {
      cwd,
      encoding: "utf-8",
      env: { ...process.env, KIT_HIDE_HOOK_SKIP_BANNER: "1", KIT_AUDIT_ANCHOR: "0" },
      timeout: 120_000,
    });
    return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
  };

  it("kit status names the schema gap instead of only saying the file is present", () => {
    const dir = repoWith('[tools]\nnode = "22"\n');
    try {
      const r = run(["status"], dir);
      assert.match(r.out, /config schema/);
      assert.match(r.out, /current is v/);
      assert.match(r.out, /kit config migrate/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("kit config recommend reports without writing", () => {
    const dir = repoWith('[tools]\nnode = "22"\n');
    try {
      const before = spawnSync("ls", ["-a", dir], { encoding: "utf-8" }).stdout;
      const r = run(["config", "recommend", "--json"], dir);
      assert.equal(r.code, 0, r.err);
      const parsed = JSON.parse(r.out) as { recommendations: Array<{ key: string; buys: string }> };
      assert.ok(parsed.recommendations.length >= 8);
      assert.ok(parsed.recommendations.every((x) => x.buys.length > 0));
      // Nothing created, nothing removed.
      assert.equal(spawnSync("ls", ["-a", dir], { encoding: "utf-8" }).stdout, before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
