import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adrFindingKey, collectAdrFindings, freezeAdrBaseline } from "./adr.js";
import { deriveAdrs } from "./adr-derive.js";
import { baselineGet, type Baseline } from "../baseline.js";
import type { AdrViolation } from "../adr.js";

describe("adrFindingKey", () => {
  it("is stable across line-number changes (excludes the line)", () => {
    const base: AdrViolation = {
      adrId: "ADR-0001",
      file: "src/web/h.ts",
      line: 3,
      rule: "forbid-import",
      detail: "pg",
      message: "no pg",
      kind: "violation",
    };
    const moved = { ...base, line: 99 };
    assert.equal(adrFindingKey(base), adrFindingKey(moved));
  });

  it("distinguishes different rule/file/detail", () => {
    const a: AdrViolation = {
      adrId: "ADR-1",
      file: "a.ts",
      line: 1,
      rule: "forbid-import",
      detail: "pg",
      message: "",
      kind: "violation",
    };
    assert.notEqual(adrFindingKey(a), adrFindingKey({ ...a, file: "b.ts" }));
    assert.notEqual(adrFindingKey(a), adrFindingKey({ ...a, detail: "mysql" }));
  });
});

describe("collectAdrFindings + freezeAdrBaseline (temp repo)", () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "kit-adr-"));
    mkdirSync(join(dir, "docs", "adr"), { recursive: true });
    mkdirSync(join(dir, "src", "web"), { recursive: true });
    writeFileSync(
      join(dir, "docs", "adr", "ADR-0001.md"),
      [
        "---",
        "id: ADR-0001",
        "title: Web must not import pg",
        "status: accepted",
        "---",
        "",
        "```toml kit-enforce",
        "[[forbid_import]]",
        'import = "^pg$"',
        'paths = "src/web/**/*.ts"',
        "```",
        "",
      ].join("\n"),
    );
    writeFileSync(join(dir, "src", "web", "h.ts"), "import { Client } from 'pg'\n");
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it("finds the accepted ADR's violation", () => {
    const f = collectAdrFindings(dir);
    assert.equal(f.enforcedCount, 1);
    assert.equal(f.violations.length, 1);
    assert.equal(f.violations[0].detail, "pg");
  });

  it("freeze snapshots the finding into the baseline, and it then suppresses", () => {
    const baseline: Baseline = { version: 1, generated: "", categories: {} };
    const total = freezeAdrBaseline(baseline, dir);
    assert.equal(total, 1);

    const frozen = new Set(baselineGet(baseline, "adr", "violations"));
    const { violations } = collectAdrFindings(dir);
    const live = violations.filter((v) => !frozen.has(adrFindingKey(v)));
    assert.equal(live.length, 0, "the frozen violation is suppressed on re-check");
  });
});

describe("deriveAdrs — a proposal is not shown until the repo disproves nothing", () => {
  let dir = "";

  /** Write a repo where `commands` imports `utils` 5× and `utils` never reciprocates. */
  const seed = (extra: Record<string, string> = {}): string => {
    const root = mkdtempSync(join(tmpdir(), "kit-derive-"));
    mkdirSync(join(root, "src", "commands"), { recursive: true });
    mkdirSync(join(root, "src", "utils"), { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(root, "src", "utils", `u${i}.ts`), "export const x = 1;\n");
      writeFileSync(join(root, "src", "commands", `c${i}.ts`), `import "../utils/u${i}.js";\n`);
    }
    for (const [relPath, body] of Object.entries(extra)) {
      mkdirSync(join(root, relPath, ".."), { recursive: true });
      writeFileSync(join(root, relPath), body);
    }
    return root;
  };

  after(() => rmSync(dir, { recursive: true, force: true }));

  it("proposes the asymmetric direction, verified against the real repo", async () => {
    dir = seed();
    const { buildRepoGraph } = await import("./repomap.js");
    const out = deriveAdrs(dir, buildRepoGraph(dir), { minSupport: 5 });
    assert.ok(out);
    assert.equal(out.root, "src");
    assert.equal(out.rejected.length, 0);
    const hit = out.proposed.find((p) => p.candidate.from === "utils");
    assert.ok(hit, "utils → commands should survive verification");
    assert.equal(hit.candidate.to, "commands");
    assert.match(hit.draft, /status: proposed/);
  });

  it("REJECTS a candidate whose rule fires today — the graph proposes, the evaluator disproves", async () => {
    // The over-match the verification pass exists for: a nested dir named after another
    // bucket, so `../commands/` resolves INSIDE utils and no cross-bucket edge exists.
    dir = seed({
      "src/utils/commands/x.ts": "export const y = 1;\n",
      "src/utils/deep/z.ts": 'import "../commands/x.js";\n',
    });
    const { buildRepoGraph } = await import("./repomap.js");
    const out = deriveAdrs(dir, buildRepoGraph(dir), { minSupport: 5 });
    assert.ok(out);
    assert.equal(out.proposed.length, 0, "an over-matching rule must not be proposed");
    assert.equal(out.rejected.length, 1);
    assert.match(out.rejected[0].reason, /fires today/);
    assert.match(out.rejected[0].reason, /src\/utils\/deep\/z\.ts/);
  });

  it("returns null when there is no source root to reason about", async () => {
    dir = mkdtempSync(join(tmpdir(), "kit-derive-empty-"));
    mkdirSync(join(dir, "pkg", "a"), { recursive: true });
    writeFileSync(join(dir, "pkg", "a", "x.ts"), "export const x = 1;\n");
    const { buildRepoGraph } = await import("./repomap.js");
    assert.equal(deriveAdrs(dir, buildRepoGraph(dir), {}), null);
  });
});
