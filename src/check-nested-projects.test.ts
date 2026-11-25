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
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
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
import { rmTemp } from "./temp-cleanup.test-support.js";

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
      rmTemp(dir);
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
      rmTemp(dir);
    }
  });

  it("passes for a pnpm workspace root, declared in pnpm-workspace.yaml", async () => {
    const dir = tree({
      "package.json": JSON.stringify({ name: "root" }),
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      "packages/a/package.json": "{}",
    });
    try {
      const r = await checkScanScope(dir);
      assert.equal(r.status, "pass", r.detail);
      assert.match(r.detail, /covered via workspaces/);
    } finally {
      rmTemp(dir);
    }
  });
});

describe("checkScanScope: Cargo workspaces", () => {
  // A Cargo workspace has one Cargo.lock at the root that pins every member, and that lockfile is
  // what osv-scanner and cargo audit read. So the members are covered, but only the members, and
  // only when the lockfile is there.
  const cargoWorkspace = (extra: Record<string, string> = {}): string =>
    tree({
      "Cargo.toml": '[workspace]\nresolver = "2"\nmembers = ["crates/*", "src-tauri"]\n',
      "crates/core/Cargo.toml": '[package]\nname = "core"\n',
      "src-tauri/Cargo.toml": '[package]\nname = "app"\n',
      ...extra,
    });

  it("passes for a Cargo workspace whose members are locked in the root Cargo.lock", async () => {
    const dir = cargoWorkspace({ "Cargo.lock": "version = 3\n" });
    try {
      const r = await checkScanScope(dir);
      assert.equal(r.status, "pass", r.detail);
      assert.match(r.detail, /Cargo workspace: crates\/core, src-tauri/);
    } finally {
      rmTemp(dir);
    }
  });

  it("still warns for Cargo workspace members when there is no root Cargo.lock to scan", async () => {
    const dir = cargoWorkspace();
    try {
      const r = await checkScanScope(dir);
      assert.equal(r.status, "warn", r.detail);
      assert.match(r.detail, /2 nested project\(s\) NOT covered/);
    } finally {
      rmTemp(dir);
    }
  });

  it("still warns for a nested project that is not a Cargo workspace member", async () => {
    const dir = cargoWorkspace({ "Cargo.lock": "version = 3\n", "tools/web/package.json": "{}" });
    try {
      const r = await checkScanScope(dir);
      assert.equal(r.status, "warn", r.detail);
      // Only the non-member is named: the members are covered and listing them would mislead.
      assert.match(r.detail, /1 nested project\(s\) NOT covered by this scan: tools\/web /);
    } finally {
      rmTemp(dir);
    }
  });
});

describe("checkScanScope: sibling projects", () => {
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
      rmTemp(dir);
    }
  });

  it("passes quietly for an ordinary single project", async () => {
    const dir = tree({ "package.json": "{}", "src/index.ts": "export {};\n" });
    try {
      const r = await checkScanScope(dir);
      assert.equal(r.status, "pass");
      assert.match(r.detail, /scanned in place/);
    } finally {
      rmTemp(dir);
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
      rmTemp(dir);
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
      rmTemp(dir);
    }
  });

  it("finds a project one level deeper, the packages/* layout", async () => {
    const dir = tree({ "packages/a/package.json": "{}", "packages/b/Cargo.toml": "" });
    try {
      assert.deepEqual(await findNestedProjects(dir), ["packages/a", "packages/b"]);
    } finally {
      rmTemp(dir);
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
      rmTemp(dir);
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

describe("escalateManifestSkips names only the projects a scanner would read", () => {
  // Measured: with only `sub/requirements.txt`, npm audit, license check, install-script grants
  // and trivy fs (jvm) all said "no package.json found — but 1 project(s) below do (sub)".
  const skip = (name: string, detail: string): SecurityCheckResult => ({
    category: "dependency",
    name,
    status: "skip",
    detail,
  });
  const input = [
    skip("npm audit", "no package.json found"),
    skip("install-script grants", "no package.json"),
    skip("license check", "no package.json found"),
    skip("trivy fs (jvm)", "no Maven/Gradle project found"),
    skip("pip-audit", "no requirements.txt found"),
    skip("pinned versions", "no package.json or requirements.txt to check"),
    skip("osv-scanner", "no lockfiles to scan"),
  ];

  it("escalates only the skips whose manifest a nested project has", async () => {
    const dir = tree({ "sub/requirements.txt": "requests==2.0\n" });
    try {
      const facts = await scanScopeFacts(dir);
      const out = escalateManifestSkips(input, facts);
      assert.deepEqual(
        out.map((r) => [r.name, r.status]),
        [
          ["npm audit", "skip"],
          ["install-script grants", "skip"],
          ["license check", "skip"],
          ["trivy fs (jvm)", "skip"],
          ["pip-audit", "warn"],
          ["pinned versions", "warn"],
          ["osv-scanner", "warn"],
        ],
      );
      assert.match(out[4].detail, /1 project\(s\) below do \(sub\)/);
    } finally {
      rmTemp(dir);
    }
  });

  it("lists, per scanner, only the projects holding its manifest", async () => {
    const dir = tree({ "py/requirements.txt": "", "web/package.json": "{}", "jvm/pom.xml": "" });
    try {
      const out = escalateManifestSkips(input, await scanScopeFacts(dir));
      const detail = (name: string) => out.find((r) => r.name === name)?.detail ?? "";
      assert.match(detail("npm audit"), /1 project\(s\) below do \(web\)/);
      assert.match(detail("trivy fs (jvm)"), /1 project\(s\) below do \(jvm\)/);
      assert.match(detail("pip-audit"), /1 project\(s\) below do \(py\)/);
      assert.match(detail("pinned versions"), /2 project\(s\) below do \(py, web\)/);
      assert.match(detail("osv-scanner"), /3 project\(s\) below do/);
    } finally {
      rmTemp(dir);
    }
  });
});
