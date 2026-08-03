import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * `--flag value` and `--flag=value` are the same flag. kit's own `flagValue`/`flagInt` handle
 * both; several handlers hand-rolled `args.indexOf("--limit")` instead, which never matches the
 * TOKEN `--limit=50`. So the `=` form was silently dropped and the default applied, exit 0, no
 * warning:
 *
 *     kit audit log --limit 25        → 25 entries
 *     kit audit log --limit=25        → 20 entries   ← the default, silently
 *
 * For an audit log that means an operator reads a truncated trail believing it is complete. For
 * `kit auth elevate --ttl-minutes=15` it means the grant lasts longer than asked for — a silent
 * failure in the PERMISSIVE direction, which is the one that matters.
 *
 * These are end-to-end because that is where the defect lived: a unit test over `flagInt` passed
 * the whole time (the helper was correct — nothing called it).
 */

// dist/commands/flag-value-forms.test.js → the built CLI is two levels up.
const CLI = resolve(import.meta.dirname, "..", "cli.js");

function project(): { dir: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "kit-flagform-"));
  const home = mkdtempSync(join(tmpdir(), "kit-flagform-home-"));
  writeFileSync(join(dir, ".kit.toml"), "version = 1\n");
  return {
    dir,
    env: { HOME: home, KIT_IDENTITY_DIR: join(home, ".kit"), KIT_HIDE_HOOK_SKIP_BANNER: "1" },
  };
}

function run(args: string[], cwd: string, env: Record<string, string>): string {
  try {
    return execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return String(err.stdout ?? "") + String(err.stderr ?? "");
  }
}

describe("kit audit log --limit accepts both flag forms", () => {
  /** Write `n` synthetic audit entries and count how many the command renders. */
  function countRendered(limitArgs: string[]): number {
    const { dir, env } = project();
    try {
      const lines: string[] = [];
      for (let i = 1; i <= 30; i++) {
        lines.push(
          JSON.stringify({
            timestamp: `2026-08-02T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
            operation: `synthetic-op-${i}`,
            environment: "dev",
            success: true,
          }),
        );
      }
      writeFileSync(join(dir, ".kit-audit.jsonl"), lines.join("\n") + "\n");
      const out = run(["audit", "log", ...limitArgs], dir, env);
      return (out.match(/synthetic-op-\d+/g) ?? []).length;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("renders the default 20 with no flag", () => {
    assert.equal(countRendered([]), 20);
  });

  it("space-separated form honors the limit", () => {
    assert.equal(countRendered(["--limit", "25"]), 25);
  });

  it("EQUALS form honors the limit too (this is the regression)", () => {
    assert.equal(
      countRendered(["--limit=25"]),
      25,
      "--limit=25 fell back to the default 20 while reporting success",
    );
  });

  it("a non-numeric or non-positive limit falls back to the default, never to zero rows", () => {
    // Silently rendering nothing would read as "the log is empty" — the worst possible
    // misreading of an audit trail.
    for (const bad of [["--limit=abc"], ["--limit=0"], ["--limit=-5"]]) {
      assert.equal(countRendered(bad), 20, bad.join(" "));
    }
  });
});

describe("kit auth elevate --list-scopes lists instead of elevating", () => {
  it("prints every scope with its description, and does not prompt", () => {
    const { dir, env } = project();
    try {
      // The old behaviour discarded the flag and fell through to an interactive elevation for
      // scope=all. Asserting on the absence of the elevate banner is the load-bearing part.
      const out = run(["auth", "elevate", "--list-scopes"], dir, env);
      assert.match(out, /scopes/i);
      assert.ok(
        !/Confirm elevation|Enter 6-digit TOTP|scope=all/.test(out),
        `must not start an elevation: ${out.slice(0, 400)}`,
      );
      // A description from the real SCOPE_MAP — proves it rendered the mapping, not a stub.
      assert.match(out, /one-shot|reusable for the TTL/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--json emits the machine-readable mapping", () => {
    const { dir, env } = project();
    try {
      const out = run(["auth", "elevate", "--list-scopes", "--json"], dir, env);
      const parsed = JSON.parse(out) as Array<{
        key: string;
        scope: string;
        oneShot: boolean;
        description: string;
      }>;
      assert.ok(parsed.length > 0);
      for (const s of parsed) {
        assert.equal(typeof s.key, "string");
        assert.equal(typeof s.scope, "string");
        assert.equal(typeof s.oneShot, "boolean");
        assert.ok(s.description.length > 0, `${s.key} has no description`);
      }
      assert.ok(
        parsed.some((s) => s.oneShot),
        "at least one scope is one-shot — that distinction is why the list exists",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an out-of-range --ttl-minutes is REJECTED, not silently clamped", () => {
    const { dir, env } = project();
    try {
      const out = run(["auth", "elevate", "--ttl-minutes=999"], dir, env);
      assert.match(out, /--ttl-minutes must be between 1 and 240/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
