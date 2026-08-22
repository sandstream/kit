/**
 * The gate that fails on NEW debt, and the file that may only shrink.
 *
 * The parser carries the risk here, so it is tested against the shapes four package managers
 * actually emit — recorded from real runs, not invented. The shape that matters most is bun's,
 * because it puts the **package name in the object key** and in no field at all:
 *
 *   {"@babel/core":[{"id":1123528,"url":"https://github.com/advisories/GHSA-…","severity":"low"}]}
 *
 * The first version of this parser only read fields, so it found zero advisories in a repo that has
 * twenty-eight — and reported "no new advisories" about a tree containing a critical
 * deserialization type-confusion. Reading keys blindly is the opposite failure: npm nests under
 * `{"vulnerabilities": {...}}`, which would become a package called "vulnerabilities".
 *
 * The stale rule is the other half. An entry that no longer applies has to be an error, or the
 * baseline only ever grows and the gate quietly stops meaning anything.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseAuditJson,
  diffAgainstBaseline,
  renderBaseline,
  describeRemaining,
  worstSeverity,
  detectAuditRunner,
  type Advisory,
} from "./advisory-baseline.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Recorded from `bun audit --json` (bun 1.3.10): package name as the key, GHSA only in the url. */
const BUN_OUTPUT = JSON.stringify({
  "@babel/core": [
    {
      id: 1123528,
      url: "https://github.com/advisories/GHSA-4x5r-pxfx-6jf8",
      title: "@babel/core: Arbitrary File Read via sourceMappingURL Comment",
      severity: "low",
      vulnerable_versions: "<=7.29.0",
    },
  ],
  seroval: [
    {
      id: 1130123,
      url: "https://github.com/advisories/GHSA-mv8w-475r-vwqw",
      title: "seroval: Promise resolver type confusion during deserialization",
      severity: "critical",
    },
  ],
});

/** Recorded from `npm audit --json`: nested under a structural key, name in a field. */
const NPM_OUTPUT = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {
    lodash: {
      name: "lodash",
      severity: "high",
      via: [
        {
          source: 1065993,
          name: "lodash",
          title: "Command Injection in lodash",
          url: "https://github.com/advisories/GHSA-35jh-r3h4-6jhm",
          severity: "high",
        },
      ],
    },
  },
  metadata: { vulnerabilities: { critical: 0, high: 1, moderate: 0, low: 0, info: 0, total: 1 } },
});

/** pnpm's older shape: an `advisories` map keyed by numeric id, with github_advisory_id inside. */
const PNPM_OUTPUT = JSON.stringify({
  advisories: {
    "1234": {
      module_name: "minimist",
      github_advisory_id: "GHSA-xvch-5gv4-984h",
      severity: "critical",
      title: "Prototype Pollution in minimist",
    },
  },
});

describe("parseAuditJson", () => {
  it("reads bun's shape, where the package name is the object key", () => {
    const found = parseAuditJson(BUN_OUTPUT);
    assert.deepEqual(
      found.map((a) => [a.package, a.severity]),
      [
        ["@babel/core", "low"],
        ["seroval", "critical"],
      ],
    );
    assert.equal(found[1].id, "GHSA-MV8W-475R-VWQW", "the id is normalised to upper case");
  });

  it("reads npm's shape without inventing a package called 'vulnerabilities'", () => {
    const found = parseAuditJson(NPM_OUTPUT);
    assert.equal(found.length, 1);
    assert.equal(found[0].package, "lodash");
    assert.equal(found[0].id, "GHSA-35JH-R3H4-6JHM");
  });

  it("reads pnpm's shape, where the id is a field and the key is a number", () => {
    const found = parseAuditJson(PNPM_OUTPUT);
    assert.deepEqual(
      found.map((a) => a.package),
      ["minimist"],
    );
    assert.equal(found[0].severity, "critical");
  });

  it("finds nothing in output that carries no advisories, without throwing", () => {
    assert.deepEqual(parseAuditJson('{"vulnerabilities":{}}'), []);
    assert.deepEqual(parseAuditJson("not json at all"), []);
    assert.deepEqual(parseAuditJson(""), []);
  });

  it("normalises 'medium' to 'moderate' so the two vocabularies do not split a count", () => {
    const found = parseAuditJson(
      JSON.stringify({
        pkg: [{ url: "https://github.com/advisories/GHSA-2222-3333-4444", severity: "medium" }],
      }),
    );
    assert.equal(found[0]?.severity, "moderate");
    assert.equal(found[0]?.id, "GHSA-2222-3333-4444");
  });

  it("does not mistake arbitrary text for an advisory id", () => {
    // GHSA ids use a restricted alphabet (23456789cfghjmpqrvwx). An invented id containing `a` is
    // correctly not recognised — which this test learned the hard way, from its own bad fixture.
    const found = parseAuditJson(
      JSON.stringify({
        pkg: [{ url: "https://example.com/GHSA-aaaa-bbbb-cccc", severity: "high" }],
      }),
    );
    assert.deepEqual(found, [], "the restricted alphabet is what keeps this deterministic");
  });
});

describe("diffAgainstBaseline", () => {
  const adv = (id: string, severity: Advisory["severity"], pkg = "p"): Advisory => ({
    id,
    package: pkg,
    severity,
    title: "t",
  });

  it("fails only on what is new, and counts the rest as known debt", () => {
    const current = [adv("GHSA-A", "critical"), adv("GHSA-B", "high"), adv("GHSA-C", "low")];
    const baseline = {
      advisories: {
        "GHSA-B": { package: "p", severity: "high" as const, title: "t" },
        "GHSA-C": { package: "p", severity: "low" as const, title: "t" },
      },
    };
    const { added, stale, remaining } = diffAgainstBaseline(current, baseline);
    assert.deepEqual(
      added.map((a) => a.id),
      ["GHSA-A"],
    );
    assert.deepEqual(stale, []);
    assert.equal(describeRemaining(remaining), "1 high, 1 low");
  });

  it("treats an entry that no longer applies as a finding of its own", () => {
    const { added, stale } = diffAgainstBaseline([], {
      advisories: { "GHSA-GONE": { package: "fixed", severity: "high", title: "t" } },
    });
    assert.deepEqual(added, []);
    assert.deepEqual(
      stale.map((s) => s.id),
      ["GHSA-GONE"],
    );
  });

  it("reports the worst severity among the new ones, for the check's own severity", () => {
    assert.equal(
      worstSeverity([adv("a", "low"), adv("b", "critical"), adv("c", "high")]),
      "critical",
    );
    assert.equal(worstSeverity([]), null);
  });
});

describe("renderBaseline", () => {
  it("sorts by id and carries no timestamp, so a dependency bump is a small readable diff", () => {
    const out = renderBaseline([
      { id: "GHSA-B", package: "b", severity: "high", title: "second" },
      { id: "GHSA-A", package: "a", severity: "low", title: "first" },
    ]);
    assert.ok(out.indexOf("GHSA-A") < out.indexOf("GHSA-B"), "sorted");
    assert.doesNotMatch(out, /generated|timestamp|\d{4}-\d{2}-\d{2}/, "no clock in a data file");
    assert.deepEqual(Object.keys(JSON.parse(out).advisories), ["GHSA-A", "GHSA-B"]);
    assert.ok(out.endsWith("\n"), "newline-terminated, like every other committed file");
  });
});

describe("detectAuditRunner", () => {
  it("uses the manager the committed lockfile names", async () => {
    for (const [lockfile, manager] of [
      ["bun.lock", "bun"],
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["package-lock.json", "npm"],
    ] as const) {
      const dir = mkdtempSync(join(tmpdir(), "kit-adv-runner-"));
      try {
        writeFileSync(join(dir, lockfile), "");
        const runner = await detectAuditRunner(dir);
        assert.equal(runner?.manager, manager, lockfile);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("answers nothing when there is no lockfile — an un-audited tree is not a clean one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-adv-none-"));
    try {
      assert.equal(await detectAuditRunner(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
