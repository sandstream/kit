import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeRepo, renderClaudeMd, renderRulesMd } from "./analyze.js";

function fixtureRepo(setup: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-analyze-"));
  setup(dir);
  return dir;
}

describe("analyzeRepo", () => {
  it("returns empty defaults for a bare repo", async () => {
    const dir = fixtureRepo(() => {});
    try {
      const r = await analyzeRepo(dir);
      assert.equal(r.hasClaudeMd, false);
      assert.equal(r.hasRulesMd, false);
      assert.deepEqual(r.testRunners, []);
      assert.deepEqual(r.commitPrefixes, []);
      assert.deepEqual(r.ciFiles, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects Node + vitest + playwright from package.json", async () => {
    const dir = fixtureRepo((d) => {
      writeFileSync(
        join(d, "package.json"),
        JSON.stringify({
          name: "fixture",
          devDependencies: {
            vitest: "^1.0.0",
            "@playwright/test": "^1.40.0",
          },
        }),
      );
    });
    try {
      const r = await analyzeRepo(dir);
      assert.ok(r.testRunners.includes("vitest"));
      assert.ok(r.testRunners.includes("playwright"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects Python pytest via pyproject.toml", async () => {
    const dir = fixtureRepo((d) => {
      writeFileSync(
        join(d, "pyproject.toml"),
        `[project]\nname = "x"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n`,
      );
    });
    try {
      const r = await analyzeRepo(dir);
      assert.ok(r.testRunners.includes("pytest"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects existing CLAUDE.md + RULES.md", async () => {
    const dir = fixtureRepo((d) => {
      writeFileSync(join(d, "CLAUDE.md"), "# rules\n");
      writeFileSync(join(d, "RULES.md"), "# rules\n");
    });
    try {
      const r = await analyzeRepo(dir);
      assert.equal(r.hasClaudeMd, true);
      assert.equal(r.hasRulesMd, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects CI workflow files", async () => {
    const dir = fixtureRepo((d) => {
      mkdirSync(join(d, ".github", "workflows"), { recursive: true });
      writeFileSync(join(d, ".github", "workflows", "ci.yml"), "name: CI\n");
    });
    try {
      const r = await analyzeRepo(dir);
      assert.ok(r.ciFiles.length >= 1, "found at least one CI file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("renderClaudeMd", () => {
  it("includes stack + test-runner sections from the report", async () => {
    const dir = fixtureRepo((d) => {
      writeFileSync(
        join(d, "package.json"),
        JSON.stringify({
          name: "fixture",
          devDependencies: { vitest: "^1.0.0" },
        }),
      );
    });
    try {
      const r = await analyzeRepo(dir);
      const md = renderClaudeMd(r);
      assert.match(md, /vitest/i);
      assert.match(md, /Stack/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits non-empty output even for an empty report", async () => {
    const dir = fixtureRepo(() => {});
    try {
      const r = await analyzeRepo(dir);
      const md = renderClaudeMd(r);
      assert.ok(md.length > 50, "output has content");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("renderRulesMd", () => {
  it("emits string output for any report", async () => {
    const dir = fixtureRepo(() => {});
    try {
      const r = await analyzeRepo(dir);
      const md = renderRulesMd(r);
      assert.equal(typeof md, "string");
      assert.ok(md.length > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
