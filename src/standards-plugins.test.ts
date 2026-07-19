import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  globToRegExp,
  loadStandardPlugins,
  evaluatePluginFindings,
  checkStandardsPlugins,
  collectPluginKeys,
  pluginKey,
  hasReDoSRisk,
  DEFAULT_PLUGIN_DIR,
} from "./standards-plugins.js";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "kit-splugin-"));
}
function writePlugin(repo: string, name: string, toml: string): void {
  const dir = join(repo, DEFAULT_PLUGIN_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), toml);
}

describe("standards-plugins — globToRegExp", () => {
  it("handles **, *, and literal segments", () => {
    assert.ok(globToRegExp("**/*.test.ts").test("src/deep/a.test.ts"));
    assert.ok(globToRegExp("scripts/**").test("scripts/x/y.ts"));
    assert.ok(globToRegExp("*.md").test("README.md"));
    assert.ok(!globToRegExp("*.md").test("docs/README.md")); // * doesn't cross /
  });
});

describe("standards-plugins — loadStandardPlugins (fail-closed)", () => {
  it("loads a valid plugin", () => {
    const repo = tmpRepo();
    try {
      writePlugin(
        repo,
        "no-console.toml",
        `[standard]
id = "no-console"
title = "No console.log"
applies_to = ["typescript"]
match = 'console\\.log'
`,
      );
      const { plugins, integrity } = loadStandardPlugins(repo, [DEFAULT_PLUGIN_DIR]);
      assert.equal(integrity.length, 0);
      assert.equal(plugins.length, 1);
      assert.equal(plugins[0].id, "no-console");
      assert.equal(plugins[0].severity, "warn");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("ignores malformed TOML / schema violations / bad regex with an integrity warn (never throws)", () => {
    const repo = tmpRepo();
    try {
      writePlugin(repo, "broken.toml", "this is not = valid = toml ===");
      writePlugin(repo, "noid.toml", `[standard]\ntitle = "x"\nmatch = "y"\n`); // missing id
      writePlugin(
        repo,
        "badre.toml",
        `[standard]\nid = "bad-re"\ntitle = "x"\nmatch = "("\n`, // unbalanced regex
      );
      writePlugin(
        repo,
        "unknownkey.toml",
        `[standard]\nid = "unk"\ntitle = "x"\nmatch = "y"\nbogus = true\n`, // strict schema rejects
      );
      const { plugins, integrity } = loadStandardPlugins(repo, [DEFAULT_PLUGIN_DIR]);
      assert.equal(plugins.length, 0);
      assert.equal(integrity.length, 4);
      assert.ok(integrity.every((i) => i.status === "warn" && i.dimension === "plugin"));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects duplicate plugin ids", () => {
    const repo = tmpRepo();
    try {
      writePlugin(repo, "a.toml", `[standard]\nid = "dup"\ntitle = "A"\nmatch = "a"\n`);
      writePlugin(repo, "b.toml", `[standard]\nid = "dup"\ntitle = "B"\nmatch = "b"\n`);
      const { plugins, integrity } = loadStandardPlugins(repo, [DEFAULT_PLUGIN_DIR]);
      assert.equal(plugins.length, 1);
      assert.ok(integrity.some((i) => /duplicate plugin id/.test(i.detail)));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("standards-plugins — evaluate + gate", () => {
  function repoWithSource(): string {
    const repo = tmpRepo();
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), "const x = 1;\nconsole.log(x);\n");
    writeFileSync(join(repo, "src", "a.test.ts"), "console.log('in test');\n");
    return repo;
  }

  it("matches the regex over source files, honoring exclude globs", () => {
    const repo = repoWithSource();
    try {
      writePlugin(
        repo,
        "nc.toml",
        `[standard]\nid = "nc"\ntitle = "No console"\nmatch = 'console\\.log'\nexclude = ["**/*.test.ts"]\n`,
      );
      const { plugins } = loadStandardPlugins(repo, [DEFAULT_PLUGIN_DIR]);
      const findings = evaluatePluginFindings(repo, plugins[0]);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].file, "src/a.ts");
      assert.equal(findings[0].line, 2);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("applies_to filters out non-matching languages", () => {
    const repo = repoWithSource();
    try {
      writePlugin(
        repo,
        "nc.toml",
        `[standard]\nid = "nc"\ntitle = "No console"\napplies_to = ["python"]\nmatch = 'console\\.log'\n`,
      );
      const r = checkStandardsPlugins({ cwd: repo, language: "typescript" });
      assert.equal(r.length, 0); // skipped: applies_to excludes typescript
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("warns net-new by default, fails when severity=fail, frozen→low warn via baseline", () => {
    const repo = repoWithSource();
    try {
      writePlugin(
        repo,
        "nc.toml",
        `[standard]\nid = "nc"\ntitle = "No console"\nseverity = "fail"\nmatch = 'console\\.log'\nexclude = ["**/*.test.ts"]\n`,
      );
      // severity=fail → net-new fails even without --enforce
      const failing = checkStandardsPlugins({ cwd: repo, language: "typescript" });
      assert.equal(failing[0].status, "fail");

      // baseline the finding → frozen low warn
      const frozen = checkStandardsPlugins({
        cwd: repo,
        language: "typescript",
        baseline: [pluginKey("nc", "src/a.ts", 2)],
      });
      assert.equal(frozen[0].status, "warn");
      assert.equal(frozen[0].severity, "low");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("collectPluginKeys snapshots current matches", () => {
    const repo = repoWithSource();
    try {
      writePlugin(
        repo,
        "nc.toml",
        `[standard]\nid = "nc"\ntitle = "No console"\nmatch = 'console\\.log'\nexclude = ["**/*.test.ts"]\n`,
      );
      const keys = collectPluginKeys(repo, "typescript");
      assert.deepEqual(keys, [pluginKey("nc", "src/a.ts", 2)]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("no plugin dir → no results (opt-in)", () => {
    const repo = tmpRepo();
    try {
      assert.deepEqual(checkStandardsPlugins({ cwd: repo, language: "typescript" }), []);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("standards-plugins — hasReDoSRisk (nested-quantifier detector)", () => {
  it("flags nested unbounded quantifiers (catastrophic backtracking)", () => {
    for (const re of ["(a+)+", "(a+)+$", "(a*)*", "(\\d+)+", "([a-z]+)+", "((ab)+)+", "(a{2,})+"]) {
      assert.equal(hasReDoSRisk(re), true, `should flag: ${re}`);
    }
  });

  it("does not flag safe patterns (no false positives)", () => {
    for (const re of [
      "console\\.log",
      "(abc)+", // quantified group, no INNER quantifier
      "a+",
      "\\d+",
      "[a-z]+",
      "(ab)*cd+",
      "(a|b)+", // alternation of single chars, no inner quantifier
      "(a{2,5})+", // BOUNDED inner quantifier is safe
      "foo(bar)?baz",
      "\\(a+\\)+", // escaped parens are literals, not a group
    ]) {
      assert.equal(hasReDoSRisk(re), false, `should NOT flag: ${re}`);
    }
  });
});

describe("standards-plugins — ReDoS-prone plugin rejected at load", () => {
  it("drops a nested-quantifier match with an integrity warn (never compiled/run)", () => {
    const repo = tmpRepo();
    try {
      writePlugin(repo, "redos.toml", `[standard]\nid = "redos"\ntitle = "x"\nmatch = '(a+)+$'\n`);
      const { plugins, integrity } = loadStandardPlugins(repo, [DEFAULT_PLUGIN_DIR]);
      assert.equal(plugins.length, 0, "the ReDoS-prone plugin must not load");
      assert.ok(
        integrity.some((i) => i.status === "warn" && /ReDoS-prone/.test(i.detail)),
        "must surface a ReDoS integrity warning",
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
