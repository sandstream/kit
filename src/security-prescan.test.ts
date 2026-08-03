import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  runPrescan,
  renderSummary,
  diffReports,
  loadReport,
  renderDiff,
  BUILTIN_CHECKS,
  type PrescanReport,
  type PrescanCheck,
} from "./security-prescan.js";

const exec = promisify(execFile);

async function makeRepoDir(path: string): Promise<void> {
  mkdirSync(path, { recursive: true });
  await exec("git", ["init", "-q", path]);
  await exec("git", ["-C", path, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", path, "config", "user.name", "test"]);
}

describe("runPrescan", () => {
  it("returns empty findings for a clean repo with gitignore + no tracked secrets", async () => {
    const root = mkdtempSync(join(tmpdir(), "prescan-clean-"));
    try {
      const repo = join(root, "clean");
      await makeRepoDir(repo);
      writeFileSync(
        join(repo, ".gitignore"),
        [
          ".env",
          ".env.local",
          ".env.*.local",
          ".env.*.backup",
          "*.prod-backup",
          "*.pem",
          "id_rsa",
          ".kit/elevation.json",
        ].join("\n"),
      );
      writeFileSync(join(repo, "README.md"), "ok");
      await exec("git", ["-C", repo, "add", "."]);
      await exec("git", ["-C", repo, "commit", "-q", "-m", "init"]);

      const report = await runPrescan({ root, persist: false, maxDepth: 3 });
      assert.equal(report.repoCount, 1);
      // gitignore-holes + tracked-secret-files should be silent.
      const offenders = report.findings.filter(
        (f) =>
          f.category === "gitignore-holes" ||
          f.category === "tracked-secret-files" ||
          f.category === "gitignore-missing",
      );
      assert.equal(offenders.length, 0, JSON.stringify(offenders));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flags tracked .env.local file as critical", async () => {
    const root = mkdtempSync(join(tmpdir(), "prescan-leak-"));
    try {
      const repo = join(root, "leaky");
      await makeRepoDir(repo);
      writeFileSync(join(repo, ".env.local"), "STRIPE_SECRET_KEY=sk_live_REDACTED\n");
      await exec("git", ["-C", repo, "add", "-f", ".env.local"]);
      await exec("git", ["-C", repo, "commit", "-q", "-m", "leak"]);

      const report = await runPrescan({ root, persist: false, maxDepth: 3 });
      const tracked = report.findings.find((f) => f.category === "tracked-secret-files");
      assert.ok(tracked, "expected tracked-secret-files finding");
      assert.equal(tracked.severity, "critical");
      assert.match(tracked.detail, /\.env\.local/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flags missing .gitignore as high-severity gitignore-missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "prescan-noign-"));
    try {
      const repo = join(root, "no-ignore");
      await makeRepoDir(repo);
      writeFileSync(join(repo, "README.md"), "no gitignore here");
      await exec("git", ["-C", repo, "add", "."]);
      await exec("git", ["-C", repo, "commit", "-q", "-m", "init"]);

      const report = await runPrescan({ root, persist: false, maxDepth: 3 });
      const f = report.findings.find((x) => x.category === "gitignore-missing");
      assert.ok(f, "expected gitignore-missing finding");
      assert.equal(f.severity, "high");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flags .gitignore-holes when patterns are missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "prescan-holes-"));
    try {
      const repo = join(root, "holes");
      await makeRepoDir(repo);
      writeFileSync(join(repo, ".gitignore"), "node_modules\n"); // missing .env, *.pem, etc
      writeFileSync(join(repo, "README.md"), "ok");
      await exec("git", ["-C", repo, "add", "."]);
      await exec("git", ["-C", repo, "commit", "-q", "-m", "init"]);

      const report = await runPrescan({ root, persist: false, maxDepth: 3 });
      const holes = report.findings.find((f) => f.category === "gitignore-holes");
      assert.ok(holes, "expected gitignore-holes finding");
      assert.equal(holes.severity, "medium");
      assert.match(holes.detail, /\.env/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("walks multiple repos under a root", async () => {
    const root = mkdtempSync(join(tmpdir(), "prescan-multi-"));
    try {
      const r1 = join(root, "repo-a");
      const r2 = join(root, "nested", "repo-b");
      await makeRepoDir(r1);
      await makeRepoDir(r2);
      for (const r of [r1, r2]) {
        writeFileSync(join(r, "README.md"), "x");
        await exec("git", ["-C", r, "add", "."]);
        await exec("git", ["-C", r, "commit", "-q", "-m", "init"]);
      }

      const report = await runPrescan({ root, persist: false, maxDepth: 4 });
      assert.equal(report.repoCount, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips node_modules and dist", async () => {
    const root = mkdtempSync(join(tmpdir(), "prescan-skip-"));
    try {
      const r1 = join(root, "repo-a");
      await makeRepoDir(r1);
      // Fake "repo" inside node_modules — must NOT be discovered.
      const nested = join(r1, "node_modules", "pkg");
      mkdirSync(nested, { recursive: true });
      mkdirSync(join(nested, ".git"));

      const report = await runPrescan({ root, persist: false, maxDepth: 5 });
      assert.equal(report.repoCount, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("renderSummary produces markdown with severity buckets", () => {
    const md = renderSummary({
      startedAt: "2026-06-09T12:00:00.000Z",
      finishedAt: "2026-06-09T12:00:30.000Z",
      root: "/tmp/x",
      repoCount: 2,
      findings: [
        {
          timestamp: "x",
          repo: "/tmp/x/a",
          category: "tracked-secret-files",
          severity: "critical",
          detail: ".env.local tracked",
        },
        {
          timestamp: "x",
          repo: "/tmp/x/b",
          category: "gitignore-holes",
          severity: "medium",
          detail: "missing patterns",
        },
      ],
    });
    assert.match(md, /# kit prescan report/);
    assert.match(md, /CRITICAL \(1\)/);
    assert.match(md, /MEDIUM \(1\)/);
    assert.match(md, /tracked-secret-files/);
  });

  it("renderSummary handles zero-finding case", () => {
    const md = renderSummary({
      startedAt: "x",
      finishedAt: "y",
      root: "/r",
      repoCount: 1,
      findings: [],
    });
    assert.match(md, /All clean/);
  });
});

describe("diffReports", () => {
  function mkReport(
    findings: Array<Partial<{ repo: string; category: string; severity: string; detail: string }>>,
  ): PrescanReport {
    return {
      startedAt: "2026-06-09T00:00:00Z",
      finishedAt: "2026-06-09T00:01:00Z",
      root: "/r",
      repoCount: 1,
      findings: findings.map((f, i) => ({
        timestamp: `2026-06-09T00:00:0${i}Z`,
        repo: f.repo ?? "/r/a",
        category: f.category ?? "test",
        severity: (f.severity ?? "medium") as never,
        detail: f.detail ?? `finding ${i}`,
      })),
    };
  }

  it("identifies added findings when latest has new findings", () => {
    const baseline = mkReport([{ category: "gitignore-holes", detail: "x" }]);
    const latest = mkReport([
      { category: "gitignore-holes", detail: "x" },
      { category: "secret-leak", detail: "y" },
    ]);
    const diff = diffReports(baseline, latest);
    assert.equal(diff.added.length, 1);
    assert.equal(diff.added[0].category, "secret-leak");
    assert.equal(diff.removed.length, 0);
    assert.equal(diff.unchanged.length, 1);
  });

  it("identifies removed findings when latest is missing baseline entries", () => {
    const baseline = mkReport([
      { category: "gitignore-holes", detail: "x" },
      { category: "secret-leak", detail: "y" },
    ]);
    const latest = mkReport([{ category: "gitignore-holes", detail: "x" }]);
    const diff = diffReports(baseline, latest);
    assert.equal(diff.added.length, 0);
    assert.equal(diff.removed.length, 1);
    assert.equal(diff.removed[0].category, "secret-leak");
    assert.equal(diff.unchanged.length, 1);
  });

  it("handles identical reports (no drift)", () => {
    const r = mkReport([{ category: "x", detail: "y" }]);
    const diff = diffReports(r, r);
    assert.equal(diff.added.length, 0);
    assert.equal(diff.removed.length, 0);
    assert.equal(diff.unchanged.length, 1);
  });

  it("treats same category but different detail as different findings", () => {
    const baseline = mkReport([{ category: "secret-leak", detail: "file-a leaked" }]);
    const latest = mkReport([{ category: "secret-leak", detail: "file-b leaked" }]);
    const diff = diffReports(baseline, latest);
    assert.equal(diff.added.length, 1);
    assert.equal(diff.removed.length, 1);
    assert.equal(diff.unchanged.length, 0);
  });

  it("loadReport parses JSONL findings file", async () => {
    const path = mkdtempSync(join(tmpdir(), "prescan-load-"));
    const file = join(path, "report.jsonl");
    const findings = [
      { timestamp: "t1", repo: "/r/a", category: "x", severity: "high", detail: "d1" },
      { timestamp: "t2", repo: "/r/b", category: "y", severity: "low", detail: "d2" },
    ];
    writeFileSync(file, findings.map((f) => JSON.stringify(f)).join("\n") + "\n");
    try {
      const report = await loadReport(file);
      assert.equal(report.findings.length, 2);
      assert.equal(report.repoCount, 2);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("renderDiff outputs human-readable markdown", () => {
    const baseline = mkReport([{ category: "old", detail: "fixed" }]);
    const latest = mkReport([{ category: "new", detail: "regression" }]);
    const md = renderDiff(diffReports(baseline, latest));
    assert.match(md, /Added \(regressions\)\*\*: 1/);
    assert.match(md, /Removed \(fixed\)\*\*: 1/);
    assert.match(md, /REGRESSIONS/);
    assert.match(md, /FIXED/);
  });

  it("renderDiff handles no-drift case", () => {
    const r = mkReport([{ category: "x", detail: "y" }]);
    const md = renderDiff(diffReports(r, r));
    assert.match(md, /No drift/);
  });
});

describe("plugin-pattern checks", () => {
  it("registers all built-in checks with unique names", () => {
    const names = BUILTIN_CHECKS.map((c) => c.name);
    const unique = new Set(names);
    assert.equal(unique.size, names.length, "BUILTIN_CHECKS must have unique names");
    assert.ok(names.includes("gitignore-holes"));
    assert.ok(names.includes("tracked-secret-files"));
    assert.ok(names.includes("secret-leak"));
    assert.ok(names.includes("npm-audit"));
    assert.ok(names.includes("bumblebee"));
  });

  it("--only filter runs only the listed checks", async () => {
    const root = mkdtempSync(join(tmpdir(), "prescan-only-"));
    try {
      const repo = join(root, "leaky");
      await makeRepoDir(repo);
      writeFileSync(join(repo, ".env.local"), "X=Y\n");
      await exec("git", ["-C", repo, "add", "-f", ".env.local"]);
      await exec("git", ["-C", repo, "commit", "-q", "-m", "init"]);

      const report = await runPrescan({
        root,
        persist: false,
        maxDepth: 3,
        onlyChecks: ["tracked-secret-files"], // skip gitignore-holes etc
      });
      // Should only see tracked-secret-files findings.
      assert.ok(report.findings.length >= 1);
      assert.ok(
        report.findings.every((f) => f.category === "tracked-secret-files"),
        `expected only tracked-secret-files, got: ${JSON.stringify(report.findings.map((f) => f.category))}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--skip filter excludes named checks", async () => {
    const root = mkdtempSync(join(tmpdir(), "prescan-skip-"));
    try {
      const repo = join(root, "incomplete-ignore");
      await makeRepoDir(repo);
      writeFileSync(join(repo, ".gitignore"), "node_modules\n"); // gitignore-holes
      writeFileSync(join(repo, "README.md"), "ok");
      await exec("git", ["-C", repo, "add", "."]);
      await exec("git", ["-C", repo, "commit", "-q", "-m", "init"]);

      const report = await runPrescan({
        root,
        persist: false,
        maxDepth: 3,
        skipChecks: ["gitignore-holes"],
      });
      assert.ok(
        report.findings.every((f) => f.category !== "gitignore-holes"),
        `expected no gitignore-holes, got: ${JSON.stringify(report.findings.map((f) => f.category))}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("extraChecks adds custom checks to the run", async () => {
    const root = mkdtempSync(join(tmpdir(), "prescan-extra-"));
    try {
      const repo = join(root, "clean");
      await makeRepoDir(repo);
      writeFileSync(
        join(repo, ".gitignore"),
        [
          ".env",
          ".env.local",
          ".env.*.local",
          ".env.*.backup",
          "*.prod-backup",
          "*.pem",
          "id_rsa",
          ".kit/elevation.json",
        ].join("\n"),
      );
      writeFileSync(join(repo, "README.md"), "x");
      await exec("git", ["-C", repo, "add", "."]);
      await exec("git", ["-C", repo, "commit", "-q", "-m", "init"]);

      const custom: PrescanCheck = {
        name: "test-marker",
        tier: "default",
        scope: "per-repo",
        run: async (repoPath) => [
          {
            timestamp: "t",
            repo: repoPath,
            category: "custom-test-marker",
            severity: "low",
            detail: "custom check ran",
          },
        ],
      };
      const report = await runPrescan({
        root,
        persist: false,
        maxDepth: 3,
        extraChecks: [custom],
      });
      const marker = report.findings.find((f) => f.category === "custom-test-marker");
      assert.ok(marker, "expected custom-test-marker finding");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("deep-tier checks don't run in default mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "prescan-tier-"));
    try {
      const repo = join(root, "with-deps");
      await makeRepoDir(repo);
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
      writeFileSync(
        join(repo, "package-lock.json"),
        JSON.stringify({ name: "x", lockfileVersion: 3 }),
      );
      writeFileSync(
        join(repo, ".gitignore"),
        [
          ".env",
          ".env.local",
          "*.pem",
          "id_rsa",
          ".kit/elevation.json",
          ".env.*.backup",
          "*.prod-backup",
          ".env.*.local",
        ].join("\n"),
      );
      await exec("git", ["-C", repo, "add", "."]);
      await exec("git", ["-C", repo, "commit", "-q", "-m", "init"]);

      const report = await runPrescan({ root, persist: false, maxDepth: 3, deep: false });
      // No npm-audit / workflow-drift / audit-gap findings (those are deep-only).
      const deepCategories = ["npm-audit", "npm-audit-skipped", "workflow-drift", "audit-gap"];
      const found = report.findings.filter((f) => deepCategories.includes(f.category));
      assert.equal(found.length, 0, `unexpected deep-tier findings: ${JSON.stringify(found)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("renderDiff", () => {
  function mkFinding(over: {
    repo?: string;
    category?: string;
    severity?: "info" | "low" | "medium" | "high" | "critical";
    detail?: string;
    remediation?: string;
  }) {
    return {
      timestamp: "2026-06-09T00:00:00Z",
      repo: over.repo ?? "/r/a",
      category: over.category ?? "test",
      severity: over.severity ?? "medium",
      detail: over.detail ?? "some detail",
      ...(over.remediation === undefined ? {} : { remediation: over.remediation }),
    };
  }

  it("always emits the three count lines, even for a completely empty diff", () => {
    const md = renderDiff({ added: [], removed: [], unchanged: [] });
    assert.match(md, /^# kit prescan diff$/m);
    assert.match(md, /- \*\*Added \(regressions\)\*\*: 0$/m);
    assert.match(md, /- \*\*Removed \(fixed\)\*\*: 0$/m);
    assert.match(md, /- \*\*Unchanged \(persistent\)\*\*: 0$/m);
  });

  it("reports 'No drift' for an empty diff, wording it as zero carried-over findings", () => {
    const md = renderDiff({ added: [], removed: [], unchanged: [] });
    // An entirely empty diff is indistinguishable from "nothing was scanned":
    // both render the reassuring No-drift block. Pinning the wording so a
    // future change that distinguishes the two is a deliberate, visible one.
    assert.match(md, /## No drift/);
    assert.match(md, /0 finding\(s\) carried over unchanged\. No regressions, no fixes\./);
  });

  it("suppresses the 'No drift' block whenever anything was added", () => {
    const md = renderDiff({ added: [mkFinding({})], removed: [], unchanged: [] });
    // A regression must never be reported under a "No drift" heading — an
    // operator skimming for that phrase would stop reading.
    assert.ok(!md.includes("No drift"), md);
    assert.match(md, /## REGRESSIONS — new findings since baseline \(1\)/);
  });

  it("suppresses the 'No drift' block whenever anything was removed", () => {
    const md = renderDiff({ added: [], removed: [mkFinding({})], unchanged: [] });
    assert.ok(!md.includes("No drift"), md);
    assert.match(md, /## FIXED — gone since baseline \(1\)/);
  });

  it("places the regressions section before the fixed section", () => {
    const md = renderDiff({
      added: [mkFinding({ category: "new-leak" })],
      removed: [mkFinding({ category: "old-hole" })],
      unchanged: [],
    });
    const regressionsAt = md.indexOf("## REGRESSIONS");
    const fixedAt = md.indexOf("## FIXED");
    assert.ok(regressionsAt >= 0 && fixedAt >= 0, md);
    // Bad news first: regressions are what the reader must act on.
    assert.ok(regressionsAt < fixedAt, `REGRESSIONS at ${regressionsAt}, FIXED at ${fixedAt}`);
  });

  it("preserves the caller's ordering of findings within a section", () => {
    const md = renderDiff({
      added: [
        mkFinding({ detail: "first-detail" }),
        mkFinding({ detail: "second-detail" }),
        mkFinding({ detail: "third-detail" }),
      ],
      removed: [],
      unchanged: [],
    });
    // renderDiff does no sorting of its own, so diffReports' ordering (and
    // hence any severity ordering a caller applies) survives to the report.
    assert.ok(md.indexOf("first-detail") < md.indexOf("second-detail"), md);
    assert.ok(md.indexOf("second-detail") < md.indexOf("third-detail"), md);
  });

  it("renders an added finding's severity bare and a removed finding's as 'was <severity>'", () => {
    const md = renderDiff({
      added: [mkFinding({ repo: "/r/a", category: "secret-leak", severity: "critical" })],
      removed: [mkFinding({ repo: "/r/b", category: "gitignore-holes", severity: "low" })],
      unchanged: [],
    });
    assert.match(md, /### \/r\/a — secret-leak \(critical\)/);
    // The "was" prefix is what tells a reader the severity is historical.
    assert.match(md, /### \/r\/b — gitignore-holes \(was low\)/);
  });

  it("includes the remediation hint for added findings as a blockquote", () => {
    const md = renderDiff({
      added: [mkFinding({ remediation: "add .env.local to .gitignore" })],
      removed: [],
      unchanged: [],
    });
    assert.match(md, /^> \*\*Fix\*\*: add \.env\.local to \.gitignore$/m);
  });

  it("omits the remediation hint for removed findings even when the finding carries one", () => {
    const md = renderDiff({
      added: [],
      removed: [mkFinding({ remediation: "rotate the leaked key" })],
      unchanged: [],
    });
    // Asymmetric on purpose: a finding that is gone needs no fix instructions.
    // Asserting it so the asymmetry cannot be "tidied away" unnoticed.
    assert.ok(!md.includes("rotate the leaked key"), md);
    assert.ok(!md.includes("**Fix**"), md);
  });

  it("omits a section entirely rather than printing an empty heading", () => {
    const addedOnly = renderDiff({ added: [mkFinding({})], removed: [], unchanged: [] });
    assert.ok(!addedOnly.includes("## FIXED"), addedOnly);
    const removedOnly = renderDiff({ added: [], removed: [mkFinding({})], unchanged: [] });
    assert.ok(!removedOnly.includes("## REGRESSIONS"), removedOnly);
  });

  it("emits finding detail verbatim, without escaping markdown", () => {
    // A detail string is scanner output (file paths, matched patterns) and is
    // interpolated raw, so it can forge a section heading in the report. This
    // diff has ZERO removed findings, yet a "## FIXED" heading appears purely
    // because a detail contained one.
    const md = renderDiff({
      added: [mkFinding({ detail: "## FIXED — gone since baseline (99)" })],
      removed: [],
      unchanged: [],
    });
    assert.match(md, /- \*\*Removed \(fixed\)\*\*: 0$/m);
    assert.ok(md.includes("## FIXED — gone since baseline (99)"), md);
  });

  it("counts unchanged findings in the header but never lists them individually", () => {
    const md = renderDiff({
      added: [mkFinding({ detail: "added-detail" })],
      removed: [],
      unchanged: [
        mkFinding({ detail: "persistent-detail-one" }),
        mkFinding({ detail: "persistent-detail-two" }),
      ],
    });
    assert.match(md, /- \*\*Unchanged \(persistent\)\*\*: 2$/m);
    // Persistent findings are deliberately summarised as a count only — the
    // diff is about what changed, and listing them would bury the regressions.
    assert.ok(!md.includes("persistent-detail-one"), md);
    assert.ok(!md.includes("persistent-detail-two"), md);
  });
});
