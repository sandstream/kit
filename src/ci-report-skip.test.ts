/**
 * A check that could not run must read as neither passed nor failed.
 *
 * `kit ci` got this wrong in opposite directions on the two CI surfaces (#517). The GitHub
 * step-summary icon was `pass ? ✅ : warn ? ⚠️ : ❌` — no branch for `skip` — so a run in a
 * directory that is not a project printed twenty-plus ❌ rows above a footer reading
 * "**2 passed, 1 failed, 1 warnings**". Among the red rows: `socket scan` (excluded by design,
 * cloud-only), `bumblebee` (switched off via `KIT_BUMBLEBEE`), and opt-in SAST — kit's own
 * documented design rendered as broken. The GitLab JUnit writer emitted a **bare** testcase for
 * a skip, and JUnit reads an empty testcase as PASSED: measured 24 of 26 checks green that never
 * ran.
 *
 * The machine-read surface was right the whole time (`emitGithubAnnotations` annotates only
 * `fail`/`warn`, and `allOk` never gated on skips), which is the worse way round: the human is
 * the one who concludes "twenty things are broken" or "everything is green".
 *
 * So the properties pinned here are arithmetic ones — the rows and the tally must add up, and a
 * skipped check must be distinguishable from a passing one in every format that prints both.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { statusIcon, statusRank } from "./commands/ci.js";

const CLI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");

/** A repo where almost nothing applies: no git, no manifests — the shape that exposed this. */
function bareRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-ci-skip-"));
  writeFileSync(join(dir, ".kit.toml"), '[secrets.keys]\nMY_KEY = { source = "env" }\n');
  return dir;
}

function runCi(dir: string, args: string[], env: Record<string, string> = {}): string {
  const r = spawnSync(process.execPath, [CLI_PATH, "ci", ...args], {
    cwd: dir,
    encoding: "utf-8",
    env: {
      ...process.env,
      KIT_HIDE_HOOK_SKIP_BANNER: "1",
      KIT_AUDIT_ANCHOR: "0",
      // Keep MY_KEY unset so exactly one check fails, as in the report that prompted this.
      ...env,
    },
    timeout: 300_000,
  });
  return (r.stdout ?? "") + (r.stderr ?? "");
}

describe("statusIcon / statusRank", () => {
  it("gives a skip its own icon rather than the failure one", () => {
    assert.equal(statusIcon("pass"), "✅");
    assert.equal(statusIcon("warn"), "⚠️");
    assert.equal(statusIcon("fail"), "❌");
    assert.equal(statusIcon("skip"), "➖");
    // Any future status must not silently borrow ❌ either.
    assert.equal(statusIcon("something-new"), "➖");
  });

  it("orders what must be acted on first and what could not run last", () => {
    const order = ["skip", "pass", "fail", "warn"].sort((a, b) => statusRank(a) - statusRank(b));
    assert.deepEqual(order, ["fail", "warn", "pass", "skip"]);
  });
});

describe("GitHub step summary", () => {
  it("adds up: every icon count matches the footer, and skips are not failures", () => {
    const dir = bareRepo();
    const summary = join(dir, "summary.md");
    try {
      runCi(dir, ["--format", "github"], {
        GITHUB_ACTIONS: "true",
        GITHUB_STEP_SUMMARY: summary,
      });
      assert.ok(existsSync(summary), "the step summary must be written");
      const md = readFileSync(summary, "utf-8");

      const count = (icon: string): number =>
        md.split("\n").filter((l) => l.startsWith(`| ${icon} |`)).length;
      const footer = /\*\*(\d+) passed, (\d+) failed, (\d+) warnings, (\d+) skipped\*\*/.exec(md);
      assert.ok(footer, `footer must report all four counts:\n${md.slice(-300)}`);
      const [, passed, failed, warnings, skipped] = footer.map(Number);

      assert.equal(count("✅"), passed, "pass rows vs footer");
      assert.equal(count("❌"), failed, "fail rows vs footer");
      assert.equal(count("⚠️"), warnings, "warn rows vs footer");
      assert.equal(count("➖"), skipped, "skip rows vs footer");

      // The shape that produced the report: many skips, exactly one real failure.
      assert.ok(skipped > 5, "a bare directory skips most checks");
      assert.equal(failed, 1, "only the unset secret actually failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("puts the failure first and the skips last", () => {
    const dir = bareRepo();
    const summary = join(dir, "summary.md");
    try {
      runCi(dir, ["--format", "github"], {
        GITHUB_ACTIONS: "true",
        GITHUB_STEP_SUMMARY: summary,
      });
      const rows = readFileSync(summary, "utf-8")
        .split("\n")
        .filter((l) => /^\| (✅|⚠️|❌|➖) \|/.test(l));
      const icons = rows.map((l) => l.slice(2, l.indexOf(" |", 2)));
      assert.equal(icons[0], "❌", "act-on-this belongs at the top");
      assert.equal(icons[icons.length - 1], "➖", "could-not-run belongs at the bottom");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("GitLab JUnit", () => {
  it("marks a skipped check as skipped, not as an empty (passing) testcase", () => {
    const dir = bareRepo();
    try {
      runCi(dir, ["--format", "gitlab"]);
      const xml = readFileSync(join(dir, "kit-report.xml"), "utf-8");

      const attrs = /tests="(\d+)" failures="(\d+)" errors="\d+" skipped="(\d+)"/.exec(xml);
      assert.ok(attrs, "the suite must declare a skipped count");
      const [, tests, failures, skipped] = attrs.map(Number);
      assert.ok(skipped > 5);
      assert.equal(failures, 1);

      const skippedTags = (xml.match(/<skipped /g) ?? []).length;
      assert.equal(skippedTags, skipped, "one <skipped> per skipped check");

      // No testcase may be empty: an empty one reads as passed, which is how 24 checks that
      // never ran showed up green.
      const cases = xml.match(/<testcase [^>]*>([\s\S]*?)<\/testcase>/g) ?? [];
      const empty = cases.filter(
        (c) => !c.includes("<failure") && !c.includes("<system-out") && !c.includes("<skipped"),
      );
      assert.equal(
        empty.length,
        tests - skipped - failures - (xml.match(/<system-out>/g) ?? []).length,
        "only genuine passes may be empty testcases",
      );
      // And the reason survives into the report.
      assert.match(xml, /<skipped message="[^"]+"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
