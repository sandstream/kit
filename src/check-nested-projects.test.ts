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

import {
  checkScanScope,
  findNestedProjects,
  scanScopeFacts,
  escalateManifestSkips,
  lookedInTheWrongPlace,
  type ScanScope,
} from "./check-nested-projects.js";
import type { SecurityCheckResult } from "./check-security.js";

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

/**
 * "There is nothing to scan" and "I looked in the wrong place" are the same sentence from a
 * scanner's point of view and opposite facts from the operator's. Each individual skip was true;
 * the sum of them was a green verdict over an empty directory. So the meaning is resolved once,
 * from the scope facts, and only in the wrong-place case.
 */
describe("escalateManifestSkips", () => {
  const skip = (name: string, detail: string): SecurityCheckResult => ({
    category: "dependency",
    name,
    status: "skip",
    detail,
  });
  const wrongPlace: ScanScope = {
    rootManifest: false,
    nested: ["web", "illithid"],
    workspaces: false,
  };
  const ordinary: ScanScope = { rootManifest: true, nested: [], workspaces: false };

  it("turns a manifest-absence skip into a warning that says where the code is", () => {
    const out = escalateManifestSkips(
      [skip("npm audit", "no package.json found"), skip("osv-scanner", "no lockfiles to scan")],
      wrongPlace,
    );
    assert.deepEqual(
      out.map((r) => r.status),
      ["warn", "warn"],
    );
    for (const r of out) {
      assert.match(r.detail, /looked in the wrong place/);
      assert.match(r.detail, /web/);
      assert.equal(r.severity, "medium");
    }
  });

  it("leaves a skip that is genuinely not applicable alone", () => {
    // Socket is cloud-only and excluded by design; SAST is opt-in. Neither is about a manifest, and
    // rewriting them would make the report noise in exactly the repos that are set up correctly.
    const out = escalateManifestSkips(
      [
        skip("socket scan", "Socket is cloud-only — excluded from kit's local-first check"),
        skip("semgrep SAST", "SAST opt-in: set KIT_SEMGREP_CONFIG"),
      ],
      wrongPlace,
    );
    assert.deepEqual(
      out.map((r) => r.status),
      ["skip", "skip"],
    );
  });

  it("changes nothing in an ordinary project", () => {
    const input = [skip("pip-audit", "no requirements.txt found")];
    assert.deepEqual(escalateManifestSkips(input, ordinary), input);
    assert.equal(lookedInTheWrongPlace(ordinary), false);
  });

  it("changes nothing for a workspace root that genuinely covers its children", async () => {
    const dir = tree({
      "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
      "packages/a/package.json": "{}",
    });
    try {
      const facts = await scanScopeFacts(dir);
      assert.equal(lookedInTheWrongPlace(facts), false, "a root manifest exists — kit is in place");
      const input = [skip("npm audit", "no package.json found")];
      assert.deepEqual(escalateManifestSkips(input, facts), input);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not touch a result that already passed or failed", () => {
    const pass: SecurityCheckResult = {
      category: "dependency",
      name: "pinned versions",
      status: "pass",
      detail: "no package.json found but irrelevant",
    };
    assert.equal(escalateManifestSkips([pass], wrongPlace)[0].status, "pass");
  });
});
