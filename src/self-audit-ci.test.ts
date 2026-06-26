import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractScriptRefs, resolveNpmScript, runCiScriptAudit } from "./self-audit-ci.js";

// Repo root: this compiled test lives at dist/self-audit-ci.test.js, so the repo
// root is one directory up from dist/.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const FIXTURE = `name: Example
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: node scripts/run-thing.mjs
      - run: python3 skills/triage/scripts/triage.py npm foo
      - run: npm run build
      - run: pnpm run lint
      - run: node scripts/\${{ matrix.script }}.mjs
      - run: npm run \${{ env.TASK }}
      - run: npm test
`;

describe("extractScriptRefs", () => {
  it("extracts node, python, and npm/pnpm run refs", () => {
    const refs = extractScriptRefs(FIXTURE, "wf.yml");
    const byKind = (k: string) => refs.filter((r) => r.kind === k).map((r) => r.ref);

    assert.deepEqual(byKind("node"), ["scripts/run-thing.mjs"]);
    assert.deepEqual(byKind("python"), ["skills/triage/scripts/triage.py"]);
    // npm test (no `run`) is intentionally not matched by the npm-run matcher.
    assert.deepEqual(byKind("npm"), ["build", "lint"]);
  });

  it("skips refs containing ${{ }} interpolation", () => {
    const refs = extractScriptRefs(FIXTURE, "wf.yml");
    assert.ok(
      refs.every((r) => !r.ref.includes("${{")),
      "interpolated refs must be dropped",
    );
    // The two interpolated lines (node + npm) must not appear as refs.
    assert.ok(!refs.some((r) => r.ref.includes("matrix")));
    assert.ok(!refs.some((r) => r.ref.includes("env")));
  });

  it("records accurate 1-based line numbers and the file", () => {
    const refs = extractScriptRefs(FIXTURE, "wf.yml");
    const node = refs.find((r) => r.kind === "node");
    assert.ok(node);
    assert.equal(node.file, "wf.yml");
    assert.equal(node.line, 7);
  });

  it("returns empty for text with no script refs", () => {
    assert.deepEqual(extractScriptRefs("name: x\non: [push]\n", "wf.yml"), []);
  });
});

describe("resolveNpmScript", () => {
  it("true when the script name is present", () => {
    assert.equal(resolveNpmScript("build", { build: "tsc", lint: "eslint" }), true);
  });

  it("false when the script name is absent", () => {
    assert.equal(resolveNpmScript("missing", { build: "tsc" }), false);
  });

  it("false against an empty scripts map", () => {
    assert.equal(resolveNpmScript("build", {}), false);
  });
});

describe("runCiScriptAudit", () => {
  it("kit's real workflows all resolve (0 fail)", () => {
    const results = runCiScriptAudit(REPO_ROOT);
    const fails = results.filter((r) => r.status === "fail");
    assert.deepEqual(
      fails.map((f) => `${f.name}: ${f.detail}`),
      [],
      "every CI script ref in kit's workflows must resolve post-1.35.0",
    );
    // A clean repo collapses to a single pass summary.
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "pass");
    assert.match(results[0].detail, /refs across \d+ workflows all resolve/);
  });

  it("reports exactly one fail for a missing referenced script", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-ci-audit-"));
    try {
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      writeFileSync(
        join(dir, ".github", "workflows", "broken.yml"),
        "jobs:\n  x:\n    steps:\n      - run: node scripts/does-not-exist.mjs\n",
      );
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "tmp", scripts: {} }));

      const results = runCiScriptAudit(dir);
      const fails = results.filter((r) => r.status === "fail");
      assert.equal(fails.length, 1);
      assert.equal(fails[0].name, "scripts/does-not-exist.mjs");
      assert.equal(fails[0].severity, "high");
      assert.equal(fails[0].category, "self-audit/ci-script-paths");
      assert.deepEqual(fails[0].files, [join(dir, ".github", "workflows", "broken.yml")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails an npm-run ref absent from package.json scripts", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-ci-audit-npm-"));
    try {
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      writeFileSync(
        join(dir, ".github", "workflows", "wf.yml"),
        "jobs:\n  x:\n    steps:\n      - run: npm run nonexistent\n",
      );
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "tmp", scripts: { build: "tsc" } }),
      );

      const results = runCiScriptAudit(dir);
      const fails = results.filter((r) => r.status === "fail");
      assert.equal(fails.length, 1);
      assert.equal(fails[0].name, "nonexistent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips when there are no workflows", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-ci-audit-empty-"));
    try {
      const results = runCiScriptAudit(dir);
      assert.equal(results.length, 1);
      assert.equal(results[0].status, "skip");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
