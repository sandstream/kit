import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  analyzeCountClaims,
  extractCountClaims,
  loadCountOracle,
  parseCount,
  runCountClaimsAudit,
} from "./self-audit-counts.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function write(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

const claims = (text: string) =>
  extractCountClaims(text, "README.md").map((c) => `${c.kind}=${c.stated}`);

describe("self-audit-counts — parseCount", () => {
  it("reads digits and number words, hyphenated or spaced", () => {
    assert.equal(parseCount("16"), 16);
    assert.equal(parseCount("nine"), 9);
    assert.equal(parseCount("Twelve"), 12);
    assert.equal(parseCount("twenty-seven"), 27);
    assert.equal(parseCount("eighty"), 80);
    assert.equal(parseCount("fifty three"), 53);
    assert.equal(parseCount("many"), null);
  });
});

describe("self-audit-counts — extractCountClaims", () => {
  it("reads each sound phrasing", () => {
    assert.deepEqual(claims("docs/adr holds seven ADRs."), ["adrs=7"]);
    assert.deepEqual(claims("its 12 self-hardening rules"), ["self-audit-rules=12"]);
    assert.deepEqual(claims("Sixteen self-audit rules"), ["self-audit-rules=16"]);
    assert.deepEqual(claims("exactly four runtime deps"), ["runtime-deps=4"]);
    assert.deepEqual(claims("FOUR direct production dependencies"), ["runtime-deps=4"]);
    assert.deepEqual(claims("kit's 80 commands"), ["commands=80"]);
    assert.deepEqual(claims("kit has eighty top-level commands"), ["commands=80"]);
    assert.deepEqual(claims("27 experimental commands and 53 stable commands"), [
      "experimental=27",
      "stable=53",
    ]);
  });

  it("leaves prose that does not name a counted set alone", () => {
    assert.deepEqual(claims("wire two commands into the setup script"), []);
    assert.deepEqual(claims("the SDK declares 17 hard dependencies"), []);
    assert.deepEqual(claims("the four accepted ADRs"), []);
    assert.deepEqual(claims("53 commands are `stable` and 27 are `experimental`"), []);
  });

  it("skips approximations, subsets and an opted-out line", () => {
    assert.deepEqual(claims("the CLI covers all ~80 top-level commands"), []);
    assert.deepEqual(claims("about 80 top-level commands"), []);
    assert.deepEqual(claims("these two experimental commands"), []);
    assert.deepEqual(claims("it once said seven ADRs <!-- kit-self-audit: allow-count -->"), []);
  });
});

describe("self-audit-counts — fixture repository", () => {
  let root: string;
  before(() => {
    root = mkdtempSync(join(tmpdir(), "kit-r17-"));
    write(root, "docs/adr/0001-a.md", "# a");
    write(root, "docs/adr/0002-b.md", "# b");
    write(root, "docs/adr/README.md", "# not an ADR");
    write(root, "package.json", JSON.stringify({ dependencies: { a: "1", b: "1" } }));
    write(
      root,
      "contracts/kit.opencli.json",
      JSON.stringify({
        commands: {
          one: { "x-kit-stability": "stable" },
          two: { "x-kit-stability": "stable" },
          three: { "x-kit-stability": "experimental" },
        },
      }),
    );
    write(root, "CLAUDE.md", "`docs/adr` holds seven ADRs.\nkit has two runtime deps.\n");
    write(root, "docs/SELF.md", "Audit against its 12 self-hardening rules.\n");
    write(
      root,
      "README.md",
      "kit's three commands: two stable commands and one experimental commands.\n",
    );
  });
  after(() => rmTemp(root));

  it("counts each set from its source of truth", () => {
    assert.deepEqual(loadCountOracle(root, 16), {
      "self-audit-rules": 16,
      adrs: 2,
      "runtime-deps": 2,
      commands: 3,
      stable: 2,
      experimental: 1,
    });
  });

  it("reports exactly the stale counts", () => {
    const got = analyzeCountClaims(root, 16).map(
      (m) => `${m.file}:${m.line} ${m.stated}->${m.actual}`,
    );
    assert.deepEqual(got, ["CLAUDE.md:1 7->2", "docs/SELF.md:1 12->16"]);
  });

  it("fails each stale count with its source named, and passes when they agree", () => {
    const rows = runCountClaimsAudit(root, 16);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.status === "fail"));
    assert.match(rows[1].detail, /12 self-hardening rules.*the self-audit rule table has 16/);
    const ok = runCountClaimsAudit(root, 12).filter((r) => r.files?.[0] === "docs/SELF.md:1");
    assert.deepEqual(ok, []);
  });
});

describe("self-audit-counts — ADR files and kit's own docs", () => {
  it("reads docs/adr/*.md, and skips a dated history line that carries the marker", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-r17-adr-"));
    try {
      write(root, "package.json", JSON.stringify({ dependencies: { a: "1", b: "1" } }));
      write(
        root,
        "docs/adr/0002-floor.md",
        "title: Floor — four runtime deps\n## Amended: three runtime deps <!-- kit-self-audit: allow-count -->\n",
      );
      const got = analyzeCountClaims(root, 0).map((m) => `${m.file}:${m.line} ${m.stated}`);
      assert.deepEqual(got, ["docs/adr/0002-floor.md:1 4"]);
    } finally {
      rmTemp(root);
    }
  });

  // kit-research#233 E2: CLAUDE.md said "exactly four runtime deps" and "seven ADRs" while
  // package.json had two and docs/adr more than seven. These read the real repository.
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const deps = Object.keys(
    (JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { dependencies?: object })
      .dependencies ?? {},
  ).length;

  for (const doc of ["CLAUDE.md", "AGENTS.md", "docs/adr/0002-dependency-floor.md"]) {
    it(`${doc} states the runtime dependency count package.json has (${deps})`, () => {
      const stated = extractCountClaims(readFileSync(join(repo, doc), "utf8"), doc)
        .filter((c) => c.kind === "runtime-deps")
        .map((c) => c.stated);
      assert.ok(stated.length > 0, `${doc} no longer states the floor as a count`);
      assert.deepEqual(
        stated,
        stated.map(() => deps),
      );
    });
  }

  it("no ADR or runtime-dependency count in the repository's docs has drifted", () => {
    const drift = analyzeCountClaims(repo, 0)
      .filter((m) => m.kind === "adrs" || m.kind === "runtime-deps")
      .map((m) => `${m.file}:${m.line} "${m.text}" (actual ${m.actual})`);
    assert.deepEqual(drift, []);
  });
});
