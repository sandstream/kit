/**
 * Changelog fragments (`changes/<name>.md`) replace edits to CHANGELOG.md's `[Unreleased]` lines,
 * which every pull request shared: each merge gave every other open branch a CHANGELOG conflict
 * and a full CI rerun (kit-research `one-person-factory-vs-kit` counted at least 18 in one day).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rmTemp } from "./temp-cleanup.test-support.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "changelog-fragments.mjs");

type Sections = Record<string, string>;
interface Fragments {
  SECTIONS: string[];
  parseFragment(name: string, text: string): Sections;
  readFragments(dir: string): { name: string; sections: Sections }[];
  assemble(changelog: string, fragments: { name: string; sections: Sections }[]): string;
}
const load = async (): Promise<Fragments> =>
  (await import(pathToFileURL(SCRIPT).href)) as Fragments;

const CHANGELOG = [
  "## [Unreleased]",
  "",
  "### Fixed",
  "",
  "- **Existing fix.**",
  "",
  "## [1.0.0] - 2026-01-01",
  "",
  "### Added",
  "",
  "- **Old entry.**",
  "",
].join("\n");

describe("changelog fragments", () => {
  it("parses one or more sections and rejects malformed fragments", async () => {
    const { parseFragment } = await load();
    assert.deepEqual(parseFragment("a-b.md", "### Fixed\n\n- one\n\n### Added\n\n- two\n"), {
      Fixed: "- one",
      Added: "- two",
    });
    assert.throws(() => parseFragment("Bad Name.md", "### Fixed\n\n- x"), /name must be/);
    assert.throws(() => parseFragment("x.md", "- no heading"), /before the first/);
    assert.throws(() => parseFragment("x.md", "### Bugs\n\n- x"), /unknown section/);
    assert.throws(() => parseFragment("x.md", "### Fixed\n\n"), /is empty/);
    assert.throws(() => parseFragment("x.md", ""), /no "### <Section>" heading/);
  });

  it("appends to an existing section and creates missing ones in Keep a Changelog order", async () => {
    const { assemble } = await load();
    const out = assemble(CHANGELOG, [
      { name: "a.md", sections: { Security: "- **Sec.**", Fixed: "- **New fix.**" } },
      { name: "b.md", sections: { Added: "- **New feature.**" } },
    ]);
    const unreleased = out.slice(0, out.indexOf("## [1.0.0]"));
    assert.equal(
      unreleased,
      "## [Unreleased]\n\n### Added\n\n- **New feature.**\n\n### Fixed\n\n- **Existing fix.**\n\n" +
        "- **New fix.**\n\n### Security\n\n- **Sec.**\n\n",
    );
    assert.ok(out.endsWith("## [1.0.0] - 2026-01-01\n\n### Added\n\n- **Old entry.**\n"));
  });

  it("keeps CRLF line endings and refuses a changelog with no [Unreleased] section", async () => {
    const { assemble } = await load();
    const crlf = assemble(CHANGELOG.replace(/\n/g, "\r\n"), [
      { name: "a.md", sections: { Fixed: "- **New fix.**" } },
    ]);
    assert.ok(crlf.includes("- **Existing fix.**\r\n\r\n- **New fix.**\r\n"));
    assert.ok(!/[^\r]\n/.test(crlf), "every line ending stays CRLF");
    assert.throws(() => assemble("## [1.0.0]\n", []), /no `## \[Unreleased\]`/);
  });

  it("assembles from the command line and deletes the fragments it used", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-changelog-fragments-"));
    try {
      mkdirSync(join(root, "changes"));
      writeFileSync(join(root, "CHANGELOG.md"), CHANGELOG);
      writeFileSync(join(root, "changes", "README.md"), "how to write a fragment");
      writeFileSync(join(root, "changes", "new-fix.md"), "### Fixed\n\n- **New fix.**\n");
      const run = (...args: string[]) =>
        spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: "utf8" });
      assert.equal(run("check", "--none-left").status, 1);
      const result = run("assemble");
      assert.equal(result.status, 0, result.stderr);
      assert.match(
        readFileSync(join(root, "CHANGELOG.md"), "utf8"),
        /Existing fix\.\*\*\n\n- \*\*New fix/,
      );
      assert.deepEqual(readdirSync(join(root, "changes")), ["README.md"]);
      assert.equal(run("check", "--none-left").status, 0);
      writeFileSync(join(root, "changes", "bad.md"), "### Bugs\n\n- x\n");
      assert.equal(run("check").status, 1);
    } finally {
      rmTemp(root);
    }
  });

  it("every fragment in this repository's changes/ folder is valid", async () => {
    const { readFragments } = await load();
    assert.doesNotThrow(() => readFragments(join(REPO_ROOT, "changes")));
  });
});
