/**
 * A value-taking flag must mean the same thing spelled `--flag value` and `--flag=value`.
 *
 * kit had three different argv idioms for the same job: `indexOf` (space form only),
 * `startsWith("--flag=")` (equals form only), and `flagValue` (both). Whichever one a command
 * happened to use decided which spelling silently did nothing:
 *
 *   kit self-audit --format json    -> printed TEXT, not JSON  (`--format=json` worked)
 *   kit team audit log --limit 3    -> printed `(limit: 50)`   (`--limit=3` worked)
 *
 * `unknownFlags` cannot catch this class. The flag itself is known and spelled correctly; only
 * its VALUE evaporates, and the value token is not `--`-prefixed so nothing inspects it. The
 * command then reports a confident default. That is the same defect shape as a check that
 * silently does not run.
 *
 * These tests are BEHAVIOURAL, running the real CLI. A unit test over `flagValue` proves the
 * helper works — which it always did — not that the call sites reach it, which is what was
 * broken. Each test asserts the TWO SPELLINGS AGREE, so it fails if either idiom is
 * reintroduced at the call site, in either direction.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Compiles to dist/flag-form-parity.test.js, so the built CLI is its sibling.
const CLI = resolve(import.meta.dirname, "cli.js");

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-flagform-"));
  writeFileSync(join(dir, ".kit.toml"), "version = 1\n");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "ff", version: "1.0.0", private: true }) + "\n",
  );
  return dir;
}

/** Run the built CLI with an isolated HOME + identity dir; stdout and stderr merged. */
function kit(args: string[], cwd: string): string {
  const home = mkdtempSync(join(tmpdir(), "kit-flagform-home-"));
  try {
    return execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: home,
        KIT_IDENTITY_DIR: join(home, ".kit"),
        KIT_HIDE_HOOK_SKIP_BANNER: "1",
      },
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return String(err.stdout ?? "") + String(err.stderr ?? "");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("value flags accept both --flag value and --flag=value", () => {
  it("kit team audit log --limit: both spellings yield the same limit", () => {
    const dir = project();
    try {
      const spaced = kit(["team", "audit", "log", "--limit", "3"], dir);
      const equals = kit(["team", "audit", "log", "--limit=3"], dir);
      // The pair is the assertion. `--limit 3` used to fall through to the default and print
      // `(limit: 50)` while `--limit=3` printed `(limit: 3)`.
      assert.match(spaced, /limit: 3\b/, "space form must be honoured");
      assert.match(equals, /limit: 3\b/, "equals form must stay honoured");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("kit team audit log --limit: a non-numeric value falls back, never NaN", () => {
    const dir = project();
    try {
      const out = kit(["team", "audit", "log", "--limit=abc"], dir);
      assert.doesNotMatch(out, /limit: NaN/, "unparsable limit must not surface as NaN");
      assert.match(out, /limit: 50\b/, "it must fall back to the documented default");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("kit self-audit --format: both spellings produce JSON", () => {
    const dir = project();
    try {
      // Parse the payload rather than pattern-matching a line: the output can carry Node's
      // ExperimentalWarning on stderr, and a per-line shape test is easy to get wrong in a way
      // that reports a code defect that isn't there.
      const isJson = (s: string): boolean => {
        const start = s.indexOf("{");
        const end = s.lastIndexOf("}");
        if (start < 0 || end <= start) return false;
        try {
          return typeof JSON.parse(s.slice(start, end + 1)) === "object";
        } catch {
          return false;
        }
      };
      const spaced = kit(["self-audit", "--format", "json"], dir);
      const equals = kit(["self-audit", "--format=json"], dir);
      // `--format json` used to print the human table: a documented CI flag that quietly
      // produced unparsable output for whoever piped it into jq.
      assert.equal(isJson(spaced), true, "space form must produce JSON");
      assert.equal(isJson(equals), true, "equals form must stay producing JSON");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("kit secrets vault-migrate requires --from and --to explicitly", () => {
  const config =
    '[secrets]\nstore = "1password"\n\n' +
    '[secrets.keys.API_KEY]\nsource = "1password"\nref = "op://v/i/f"\n';

  function migrateProject(): string {
    const dir = mkdtempSync(join(tmpdir(), "kit-vaultmig-"));
    writeFileSync(join(dir, ".kit.toml"), config);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "vm", version: "1.0.0", private: true }) + "\n",
    );
    return dir;
  }

  it("a missing --from prints usage instead of consuming the next token", () => {
    const dir = migrateProject();
    try {
      const out = kit(["secrets", "vault-migrate", "--to", "infisical"], dir);
      // `args[args.indexOf("--from") + 1]` indexed args[0] when the flag was absent, so this
      // printed `From: --to` and then `No keys with source="--to" found` — never the usage the
      // `!fromArg` guard exists to print.
      assert.match(out, /Usage:/, "usage must be printed when --from is missing");
      assert.doesNotMatch(out, /From: .*--to/, "a flag token must never become the value");
      assert.doesNotMatch(out, /source="--to"/, "the missing value must not reach the config scan");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a missing --from is not filled in by a preceding boolean flag either", () => {
    const dir = migrateProject();
    try {
      const out = kit(["secrets", "vault-migrate", "--dry-run", "--to", "infisical"], dir);
      assert.match(out, /Usage:/);
      assert.doesNotMatch(out, /From: .*--dry-run/, "--dry-run must not become the source backend");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a missing --to prints usage instead of consuming the next token", () => {
    const dir = migrateProject();
    try {
      const out = kit(["secrets", "vault-migrate", "--from", "1password"], dir);
      assert.match(out, /Usage:/);
      assert.doesNotMatch(out, /To: .*--from/, "a flag token must never become the target");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("both spellings still resolve a complete invocation identically", () => {
    const dir = migrateProject();
    try {
      const spaced = kit(
        ["secrets", "vault-migrate", "--from", "1password", "--to", "infisical", "--dry-run"],
        dir,
      );
      const equals = kit(
        ["secrets", "vault-migrate", "--from=1password", "--to=infisical", "--dry-run"],
        dir,
      );
      // The other half of the pair: tightening the guard must not break either working form.
      for (const [label, out] of [
        ["space", spaced],
        ["equals", equals],
      ] as const) {
        assert.match(out, /From: .*1password/, `${label} form must resolve --from`);
        assert.match(out, /To: .*infisical/, `${label} form must resolve --to`);
        assert.doesNotMatch(out, /Usage:/, `${label} form must not fall back to usage`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
