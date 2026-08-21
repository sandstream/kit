/**
 * A migration must not delete the reasoning in the file it migrates.
 *
 * `kit config migrate` re-serialised `.kit.toml` from the parsed object, so every comment was
 * deleted. Measured on kit's own config, on the v0 → v1 step whose entire job is to stamp
 * `version = 1`: 8 comment lines became 0, and a one-line change produced a 36-line diff. The
 * parsed data was identical, so re-validation passed and nothing flagged it — including the dry
 * run, which previewed `+ version = 1` and said nothing about the rewrite (#513).
 *
 * What was lost was policy reasoning: why those scanners are declared, why the refs are
 * `aqua:`-scheme-qualified, which values a field accepts. `.kit.toml` is where a repo declares
 * its policy, and kit's argument is that policy should be reviewable.
 *
 * Three properties are pinned: an add-only migration is applied as a TEXT EDIT (comments and
 * formatting survive byte-for-byte outside the insert), anything more structural returns null
 * rather than being patched by an edit that cannot express it, and the dry run says which of the
 * two would happen.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";

import { patchConfigText, countCommentLines } from "./config-migrate.js";

const CLI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");

describe("patchConfigText", () => {
  it("inserts an added top-level key before the first table, leaving the rest untouched", () => {
    const original = [
      "# why these tools matter",
      "# a second line of reasoning",
      "",
      "[tools]",
      'node = "22"   # inline note',
      "",
      "[secrets]",
      'store = "1password"',
      "",
    ].join("\n");

    const patched = patchConfigText(original, [{ path: "version", before: undefined, after: "1" }]);
    assert.ok(patched);
    assert.match(patched, /^# why these tools matter/);
    assert.match(patched, /version = 1/);
    // Every original line survives, in order.
    for (const line of original.split("\n").filter((l) => l.trim() !== "")) {
      assert.ok(patched.includes(line), `lost: ${line}`);
    }
    assert.equal(countCommentLines(patched), countCommentLines(original));
    // The key must land ABOVE the first table, or TOML scopes it into that table.
    assert.ok(patched.indexOf("version = 1") < patched.indexOf("[tools]"));
    // And the data must be what the migration intended.
    assert.equal((parse(patched) as { version?: number }).version, 1);
  });

  it("appends when the file has no table at all", () => {
    const patched = patchConfigText('name = "x"\n', [
      { path: "version", before: undefined, after: "1" },
    ]);
    assert.ok(patched);
    assert.match(patched, /name = "x"/);
    assert.equal((parse(patched) as { version?: number }).version, 1);
  });

  it("refuses anything that is not purely added top-level keys", () => {
    // A changed value: a text insert cannot express it.
    assert.equal(patchConfigText("[a]\nb = 1\n", [{ path: "a.b", before: "1", after: "2" }]), null);
    // A removal.
    assert.equal(patchConfigText("x = 1\n", [{ path: "x", before: "1", after: undefined }]), null);
    // A nested addition needs placement rules a line insert does not have.
    assert.equal(
      patchConfigText("[a]\nb = 1\n", [{ path: "a.c", before: undefined, after: "2" }]),
      null,
    );
    // Nothing to do.
    assert.equal(patchConfigText("x = 1\n", []), null);
  });
});

describe("countCommentLines", () => {
  it("counts full-line and inline comments", () => {
    assert.equal(countCommentLines("# one\nx = 1\n"), 1);
    assert.equal(countCommentLines("x = 1 # inline\n"), 1);
    assert.equal(countCommentLines("# one\ny = 2 # two\n"), 2);
    assert.equal(countCommentLines("x = 1\n"), 0);
  });
});

describe("kit config migrate (compiled CLI)", () => {
  const repo = (toml: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "kit-migrate-"));
    writeFileSync(join(dir, ".kit.toml"), toml);
    return dir;
  };
  const run = (dir: string, args: string[]): { code: number; out: string } => {
    const r = spawnSync(process.execPath, [CLI_PATH, "config", ...args], {
      cwd: dir,
      encoding: "utf-8",
      env: { ...process.env, KIT_HIDE_HOOK_SKIP_BANNER: "1", KIT_AUDIT_ANCHOR: "0" },
      timeout: 60_000,
    });
    return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
  };

  const COMMENTED = [
    "# why these tools matter",
    "# and a second line",
    "",
    "[tools]",
    'node = "22"   # inline note',
    "",
  ].join("\n");

  it("keeps every comment on the v0 -> v1 stamp", () => {
    const dir = repo(COMMENTED);
    try {
      const r = run(dir, ["migrate"]);
      assert.equal(r.code, 0, r.out);
      const after = readFileSync(join(dir, ".kit.toml"), "utf-8");
      assert.equal(countCommentLines(after), countCommentLines(COMMENTED));
      assert.match(after, /# why these tools matter/);
      assert.match(after, /# inline note/);
      assert.equal((parse(after) as { version?: number }).version, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the dry run says HOW it would apply the change", () => {
    const dir = repo(COMMENTED);
    try {
      const r = run(dir, ["migrate", "--dry-run"]);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /Applied as a text edit: comments and formatting are preserved/);
      // And it still wrote nothing.
      assert.equal(readFileSync(join(dir, ".kit.toml"), "utf-8"), COMMENTED);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--check still reports a stale config without touching it", () => {
    const dir = repo(COMMENTED);
    try {
      const r = run(dir, ["migrate", "--check"]);
      assert.equal(r.code, 1);
      assert.match(r.out, /Config is at v0/);
      assert.equal(readFileSync(join(dir, ".kit.toml"), "utf-8"), COMMENTED);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
