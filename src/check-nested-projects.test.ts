/**
 * The false green this check exists to prevent, and the three cases that must NOT warn.
 *
 * Measured on a real workspace root holding `web/` and `illithid/` side by side: every
 * manifest-dependent scanner skipped truthfully, the summary read "All 25 checks passed ✓", and the
 * same command one directory down reported 30 known dependency vulnerabilities (high), 22 unpinned
 * dependencies and 18 secret-shaped strings in history. So the property is not "warn when a
 * directory looks odd" — it is: **a verdict must never describe an empty directory as if it
 * described the code.**
 *
 * The three passing cases matter as much as the warning one. A check that warns on every monorepo
 * would be turned off within a week, and then the case it was written for goes unnoticed too.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkScanScope, findNestedProjects } from "./check-nested-projects.js";

function tree(spec: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-scope-"));
  for (const [rel, content] of Object.entries(spec)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe("checkScanScope", () => {
  it("warns, at high severity, when the manifests live below and not here", async () => {
    const dir = tree({
      "web/package.json": "{}",
      "illithid/pyproject.toml": "",
      "CLAUDE.md": "# workspace root\n",
    });
    try {
      const r = await checkScanScope(dir);
      assert.equal(r.status, "warn", r.detail);
      assert.equal(r.severity, "high", "the code being somewhere else is not a cosmetic remark");
      assert.match(r.detail, /covers none of 2 project\(s\)/);
      // The paths must be named: "something below was missed" without saying what is not actionable.
      assert.match(r.detail, /illithid/);
      assert.match(r.detail, /web/);
      assert.match(String(r.suggestion), /kit check/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes when the root declares workspaces — a root scan does cover those children", async () => {
    const dir = tree({
      "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
      "packages/a/package.json": "{}",
      "packages/b/package.json": "{}",
    });
    try {
      const r = await checkScanScope(dir);
      assert.equal(r.status, "pass", r.detail);
      assert.match(r.detail, /covered via workspaces/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns at medium when a root project has uncovered siblings under it", async () => {
    const dir = tree({
      "package.json": JSON.stringify({ name: "root", dependencies: {} }),
      "service/go.mod": "module x\n",
    });
    try {
      const r = await checkScanScope(dir);
      assert.equal(r.status, "warn", r.detail);
      assert.equal(r.severity, "medium", "the root itself WAS scanned, so this is weaker");
      assert.match(r.detail, /NOT covered/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes quietly for an ordinary single project", async () => {
    const dir = tree({ "package.json": "{}", "src/index.ts": "export {};\n" });
    try {
      const r = await checkScanScope(dir);
      assert.equal(r.status, "pass");
      assert.match(r.detail, /scanned in place/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("findNestedProjects", () => {
  it("ignores dependency and build directories, which are not the operator's projects", async () => {
    const dir = tree({
      "node_modules/left-pad/package.json": "{}",
      "dist/package.json": "{}",
      ".venv/lib/pyproject.toml": "",
      "target/Cargo.toml": "",
      "app/package.json": "{}",
    });
    try {
      assert.deepEqual(await findNestedProjects(dir), ["app"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops at the project it finds rather than enumerating that project's own packages", async () => {
    const dir = tree({
      "web/package.json": "{}",
      "web/packages/inner/package.json": "{}",
    });
    try {
      // `kit check` run inside web/ is what enumerates web/packages — reporting both here would
      // turn one misplaced run into a wall of rows.
      assert.deepEqual(await findNestedProjects(dir), ["web"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds a project one level deeper, the packages/* layout", async () => {
    const dir = tree({ "packages/a/package.json": "{}", "packages/b/Cargo.toml": "" });
    try {
      assert.deepEqual(await findNestedProjects(dir), ["packages/a", "packages/b"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
