import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adrFindingKey, collectAdrFindings, freezeAdrBaseline } from "./adr.js";
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

describe("collectAdrFindings — an enforced_by pointer must point at something real", () => {
  let dir = "";

  const seed = (frontmatterExtra: string, status = "accepted"): string => {
    const root = mkdtempSync(join(tmpdir(), "kit-enforcedby-"));
    mkdirSync(join(root, "docs", "adr"), { recursive: true });
    writeFileSync(
      join(root, "docs", "adr", "0001-x.md"),
      `---\nid: ADR-0001\ntitle: X\nstatus: ${status}\n${frontmatterExtra}---\n\n# X\n`,
    );
    return root;
  };

  after(() => rmSync(dir, { recursive: true, force: true }));

  it("fails when the named file does not exist — a claim of coverage that is not coverage", () => {
    dir = seed("enforced_by: [src/gone.test.ts]\n");
    const f = collectAdrFindings(dir);
    assert.equal(f.violations.length, 1);
    assert.equal(f.violations[0].detail, "src/gone.test.ts");
    assert.match(f.violations[0].message, /does not exist/);
  });

  it("passes when the file is there", () => {
    dir = seed("enforced_by: [src/here.test.ts]\n");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "here.test.ts"), "// enforcement lives here\n");
    assert.equal(collectAdrFindings(dir).violations.length, 0);
  });

  it("ignores a non-accepted ADR — a proposal's pointer is not yet a claim", () => {
    dir = seed("enforced_by: [src/gone.test.ts]\n", "proposed");
    assert.equal(collectAdrFindings(dir).violations.length, 0);
  });

  it("is silent when the field is absent", () => {
    dir = seed("");
    assert.equal(collectAdrFindings(dir).violations.length, 0);
  });
});
