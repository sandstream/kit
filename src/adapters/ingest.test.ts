import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSarif, parseOsv, ingest, ingestStrict } from "./ingest.js";

const sarif = JSON.stringify({
  runs: [
    {
      tool: {
        driver: {
          name: "semgrep",
          rules: [
            {
              id: "sql-injection",
              properties: { tags: ["security", "external/cwe/cwe-89"], "security-severity": "9.1" },
            },
            { id: "weak-hash", properties: { tags: ["CWE-328"] } },
          ],
        },
      },
      results: [
        {
          ruleId: "sql-injection",
          level: "error",
          message: { text: "Possible SQL injection" },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: "src/db.ts" },
                region: { startLine: 42 },
              },
            },
          ],
        },
        { ruleId: "weak-hash", level: "warning", message: { text: "MD5 used" } },
      ],
    },
  ],
});

const osv = JSON.stringify({
  results: [
    {
      packages: [
        {
          package: { name: "lodash", ecosystem: "npm", version: "4.17.11" },
          vulnerabilities: [
            {
              id: "GHSA-jf85-cpcp-j695",
              summary: "Prototype pollution in lodash",
              database_specific: { severity: "HIGH" },
            },
          ],
        },
      ],
    },
  ],
});

describe("parseSarif", () => {
  it("maps results to findings with CVSS-derived severity + CWE citation + location", () => {
    const out = parseSarif(sarif);
    assert.equal(out.length, 2);
    const sqli = out[0];
    assert.equal(sqli.category, "exposure");
    assert.equal(sqli.name, "semgrep: sql-injection");
    assert.equal(sqli.severity, "critical"); // security-severity 9.1
    assert.match(sqli.detail, /src\/db\.ts:42/);
    assert.equal(sqli.rule?.id, "CWE-89");
  });

  it("falls back to level→severity when no security-severity, and reads CWE-NNN tags", () => {
    const weak = parseSarif(sarif)[1];
    assert.equal(weak.severity, "medium"); // level warning
    assert.equal(weak.rule?.id, "CWE-328");
  });

  it("returns [] on garbage", () => {
    assert.deepEqual(parseSarif("not json"), []);
    assert.deepEqual(parseSarif(JSON.stringify({})), []);
  });
});

describe("parseOsv", () => {
  it("maps package vulnerabilities to dependency findings with OWASP-A06 citation", () => {
    const out = parseOsv(osv);
    assert.equal(out.length, 1);
    assert.equal(out[0].category, "dependency");
    assert.equal(out[0].name, "lodash@4.17.11: GHSA-jf85-cpcp-j695");
    assert.equal(out[0].severity, "high");
    assert.equal(out[0].rule?.id, "OWASP-A06");
    assert.match(out[0].detail, /Prototype pollution/);
  });

  it("keeps CVE/GHSA aliases so KEV and EPSS can match an advisory keyed by GHSA", () => {
    const out = parseOsv(
      JSON.stringify({
        results: [
          {
            packages: [
              {
                package: { name: "x", version: "1.0.0" },
                vulnerabilities: [
                  { id: "GHSA-aaaa-bbbb-cccc", aliases: ["cve-2021-44228", "not\u001b[2Jid", 7] },
                  { id: "GHSA-dddd-eeee-ffff" },
                ],
              },
            ],
          },
        ],
      }),
    );
    assert.deepEqual(out[0].aliases, ["CVE-2021-44228"]);
    assert.equal("aliases" in out[1], false);
  });

  it("returns [] on garbage", () => {
    assert.deepEqual(parseOsv("nope"), []);
  });
});

describe("ingest dispatch", () => {
  it("retains raw report text and identities for parser consumers", () => {
    const raw = `fixture\x1b[2Jghp_${"a".repeat(36)}`;
    const sarif = JSON.stringify({
      runs: [
        { tool: { driver: { name: raw } }, results: [{ ruleId: raw, message: { text: raw } }] },
      ],
    });
    const osv = JSON.stringify({
      results: [
        { packages: [{ package: { name: raw }, vulnerabilities: [{ id: raw, summary: raw }] }] },
      ],
    });
    for (const [format, data] of [
      ["sarif", sarif],
      ["osv", osv],
    ] as const) {
      const result = ingest(format, data);
      assert.equal(result[0].name, `${raw}: ${raw}`);
      assert.equal(result[0].detail, raw);
      const strict = ingestStrict(format, data);
      assert.ok(strict.ok);
      assert.deepEqual(strict.findings, result);
    }
  });

  it("routes by format; unknown → []", () => {
    assert.equal(ingest("sarif", sarif).length, 2);
    assert.equal(ingest("osv", osv).length, 1);
    // @ts-expect-error unknown format
    assert.deepEqual(ingest("nope", sarif), []);
  });
});

describe("ingestStrict", () => {
  it("parses valid input into findings (ok:true)", () => {
    const a = ingestStrict("sarif", sarif);
    assert.equal(a.ok, true);
    assert.ok(a.ok && a.findings.length === 2);
    const b = ingestStrict("osv", osv);
    assert.ok(b.ok && b.findings.length === 1);
  });

  it("accepts a valid but EMPTY report as ok:true with no findings", () => {
    const a = ingestStrict(
      "sarif",
      JSON.stringify({ runs: [{ tool: { driver: { name: "fixture" } }, results: [] }] }),
    );
    assert.ok(a.ok && a.findings.length === 0);
    const b = ingestStrict("osv", JSON.stringify({ results: [] }));
    assert.ok(b.ok && b.findings.length === 0);
  });

  it("rejects malformed JSON (ok:false) — the masked-failure case", () => {
    assert.equal(ingestStrict("sarif", "panic: boom").ok, false);
    assert.equal(ingestStrict("osv", "not json").ok, false);
  });

  it("rejects valid JSON of the wrong shape (ok:false)", () => {
    // parses fine, but it's an error blob, not a SARIF/OSV report
    assert.equal(ingestStrict("sarif", JSON.stringify({ error: "no db" })).ok, false);
    assert.equal(ingestStrict("osv", JSON.stringify({ runs: [] })).ok, false);
  });
});

describe("ingestStrict: nested report fields", () => {
  it("keeps valid findings and marks malformed SARIF records", () => {
    const invalidRuns = [
      null,
      [],
      { results: {} },
      { results: [null] },
      { results: [[]] },
      { tool: [] },
      { tool: { driver: null } },
      { tool: { driver: { name: 1 } } },
      { tool: { driver: { rules: [null] } } },
      { tool: { driver: { rules: [{ id: {} }] } } },
      { tool: { driver: { rules: [{ properties: { tags: [1] } }] } } },
      { results: [{ ruleId: 1 }] },
      { results: [{ level: 1 }] },
      { results: [{ message: "text" }] },
      { results: [{ message: { text: {} } }] },
      { results: [{ properties: { "security-severity": [] } }] },
      { results: [{ locations: {} }] },
      { results: [{ locations: [null] }] },
      { results: [{ locations: [{ physicalLocation: [] }] }] },
      { results: [{ locations: [{ physicalLocation: { artifactLocation: { uri: {} } } }] }] },
      { results: [{ locations: [{ physicalLocation: { region: { startLine: -1 } } }] }] },
    ];
    for (const run of invalidRuns) {
      const valid = { tool: { driver: { name: "valid" } }, results: [{ ruleId: "valid" }] };
      const suspect = run && !Array.isArray(run) ? { tool: valid.tool, ...run } : run;
      const result = ingestStrict("sarif", JSON.stringify({ runs: [valid, suspect] }));
      assert.ok(result.ok, JSON.stringify(run));
      assert.equal(result.coverage, "partial");
      assert.equal(result.reportGap, "malformed");
      assert.equal(result.findings.length, 1);
    }
  });
});

describe("ingestStrict: OSV records and report extensions", () => {
  it("keeps verified OSV findings while flagging malformed records", () => {
    const invalidResults = [
      {},
      null,
      [],
      { packages: {} },
      { packages: [null] },
      { packages: [[]] },
      { packages: [{}] },
      { packages: [{ package: {} }] },
      { packages: [{ package: [] }] },
      { packages: [{ package: { name: 1 } }] },
      { packages: [{ package: { version: {} } }] },
      { packages: [{ package: { ecosystem: false } }] },
      { packages: [{ vulnerabilities: {} }] },
      { packages: [{ vulnerabilities: [null] }] },
      { packages: [{ vulnerabilities: [{ summary: "missing id" }] }] },
      { packages: [{ vulnerabilities: [{ id: [] }] }] },
      { packages: [{ vulnerabilities: [{ summary: {} }] }] },
      { packages: [{ vulnerabilities: [{ database_specific: [] }] }] },
      { packages: [{ vulnerabilities: [{ database_specific: { severity: 3 } }] }] },
    ];
    for (const result of invalidResults) {
      const outcome = ingestStrict(
        "osv",
        JSON.stringify({
          results: [{ packages: [{ vulnerabilities: [{ id: "valid" }] }] }, result],
        }),
      );
      assert.ok(outcome.ok, JSON.stringify(result));
      assert.equal(outcome.coverage, "partial");
      assert.equal(outcome.reportGap, "malformed");
      assert.equal(outcome.findings.length, 1);
    }
  });

  it("requires an identified package or an advisory to support an OSV package record", () => {
    for (const record of [
      {},
      { package: {} },
      { vulnerabilities: [] },
      { package: { name: "fixture" } },
      { package: { name: "fixture" }, vulnerabilities: [] },
      { package: { commit: "unknown" }, vulnerabilities: [] },
      {
        package: { name: "fixture", version: "1", ecosystem: "npm" },
        groups: [{ ids: ["OSV-A"] }],
      },
    ]) {
      const outcome = ingestStrict("osv", JSON.stringify({ results: [{ packages: [record] }] }));
      assert.equal(outcome.ok, false, JSON.stringify(record));
      assert.equal(outcome.reportGap, "malformed");
    }
  });

  it("accepts package-only records in OSV-Scanner all-packages output", () => {
    const packages = [
      { package: { name: "fixture", version: "1", ecosystem: "npm" } },
      { package: { name: "", version: "", ecosystem: "", commit: "ab".repeat(20) } },
    ];
    const outcome = ingestStrict("osv", JSON.stringify({ results: [{ packages }] }));
    assert.deepEqual(outcome, { ok: true, findings: [] });
  });
});

describe("OSV advisory retention and report extensions", () => {
  it("keeps reported advisories when an OSV group names an omitted advisory", () => {
    const packages = [
      {
        package: { name: "fixture", version: "1", ecosystem: "npm" },
        vulnerabilities: [{ id: "OSV-A" }],
        groups: [{ ids: ["OSV-A", "OSV-B"] }],
      },
    ];
    const outcome = ingestStrict("osv", JSON.stringify({ results: [{ packages }] }));
    assert.ok(outcome.ok);
    assert.equal(outcome.coverage, "partial");
    assert.deepEqual(
      outcome.findings.map(({ name }) => name),
      ["fixture@1: OSV-A"],
    );
  });

  it("keeps an advisory whose package metadata is malformed", () => {
    const packages = [{ package: { name: 42 }, vulnerabilities: [{ id: "OSV-A" }] }];
    const outcome = ingestStrict("osv", JSON.stringify({ results: [{ packages }] }));
    assert.ok(outcome.ok);
    assert.equal(outcome.coverage, "partial");
    assert.deepEqual(
      outcome.findings.map(({ name }) => name),
      ["(package): OSV-A"],
    );
  });

  it("keeps a readable package name and ecosystem when the version is malformed", () => {
    const packages = [
      {
        package: { name: "fixture", ecosystem: "npm", version: 42 },
        vulnerabilities: [{ id: "OSV-A" }],
      },
    ];
    const outcome = ingestStrict("osv", JSON.stringify({ results: [{ packages }] }));
    assert.ok(outcome.ok);
    assert.equal(outcome.coverage, "partial");
    const finding = outcome.findings[0];
    assert.ok(finding && "package" in finding);
    assert.equal(finding.name, "fixture: OSV-A");
    assert.deepEqual(finding.package, { name: "fixture", ecosystem: "npm" });
  });

  it("retains optional fields and unknown extensions on valid reports", () => {
    assert.deepEqual(
      ingestStrict(
        "sarif",
        '{"runs":[{"tool":{"driver":{"name":"scanner"}},"results":[]}],"extension":true}',
      ),
      { ok: true, findings: [] },
    );
    assert.deepEqual(ingestStrict("osv", '{"results":[{"packages":[]}],"extension":true}'), {
      ok: true,
      findings: [],
    });
  });
});

describe("parseSarif / parseOsv — non-object JSON honors the 'malformed → []' contract", () => {
  it("returns [] for null / number / string (never throws on log.runs / log.results)", () => {
    for (const bad of ["null", "42", '"a string"']) {
      assert.deepEqual(parseSarif(bad), [], `parseSarif(${bad})`);
      assert.deepEqual(parseOsv(bad), [], `parseOsv(${bad})`);
    }
  });
});

describe("ingestStrict: a SARIF scan that did not finish", () => {
  // kit-research openai-daybreak-red-team-vs-kit: `executionSuccessful: false` with no results
  // read as "0 finding(s)", exit 0, the false clean ingestStrict exists to prevent.
  const run = (executionSuccessful: boolean, results: unknown[]) => ({
    tool: { driver: { name: "fixture-scanner" } },
    invocations: [{ executionSuccessful }],
    results,
  });
  const result = { ruleId: "R1", message: { text: "fixture" } };

  it("refuses a stopped run with no results", () => {
    const outcome = ingestStrict(
      "sarif",
      JSON.stringify({ version: "2.1.0", runs: [run(false, [])] }),
    );
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.reportGap, "partial");
      assert.match(outcome.reason, /stopped run/);
    }
  });

  it("keeps the findings of a stopped run, with a note that they are partial", () => {
    const outcome = ingestStrict("sarif", JSON.stringify({ runs: [run(false, [result])] }));
    assert.ok(outcome.ok);
    assert.equal(outcome.findings.length, 1);
    assert.equal(outcome.coverage, "partial");
    assert.match(outcome.notes?.[0] ?? "", /stopped run/);
  });

  it("reads a finished empty run as clean, as before", () => {
    const outcome = ingestStrict("sarif", JSON.stringify({ runs: [run(true, [])] }));
    assert.deepEqual(outcome, { ok: true, findings: [] });
  });

  it("refuses a SARIF version kit does not read", () => {
    const outcome = ingestStrict("sarif", JSON.stringify({ version: "9.9.9", runs: [] }));
    assert.equal(outcome.ok, false);
  });
});

describe("SARIF coverage evidence", () => {
  const tool = { driver: { name: "fixture" } };
  const finding = { ruleId: "sample", message: { text: "Example finding" } };

  it("distinguishes absent runs, absent results, and an unsupported version", () => {
    for (const [data, reason] of [
      [{ runs: [] }, "missing"],
      [{ runs: [{ tool }] }, "missing"],
      [{ runs: [{ tool, results: null }] }, "missing"],
      [{ runs: [{ tool: {} }] }, "malformed"],
      [{ version: "9.9.9", runs: [] }, "unsupported"],
    ] as const) {
      const outcome = ingestStrict("sarif", JSON.stringify(data));
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.equal(outcome.reportGap, reason);
    }
  });

  it("retains known findings when another run has no results", () => {
    const outcome = ingestStrict(
      "sarif",
      JSON.stringify({
        runs: [
          { tool, results: [finding] },
          { tool, results: null },
        ],
      }),
    );
    assert.ok(outcome.ok);
    assert.equal(outcome.coverage, "partial");
    assert.equal(outcome.findings.length, 1);
  });

  it("keeps findings when a peer record and invocation details are invalid", () => {
    const runs = [{ tool, results: [finding, null], invocations: [{}] }];
    const outcome = ingestStrict("sarif", JSON.stringify({ runs }));
    assert.ok(outcome.ok);
    assert.equal(outcome.coverage, "partial");
    assert.equal(outcome.reportGap, "malformed");
    assert.equal(outcome.findings.length, 1);
  });

  it("treats an error-level notification as incomplete", () => {
    const invocations = [
      {
        executionSuccessful: true,
        toolExecutionNotifications: [{ level: "error", message: { text: "Analysis incomplete" } }],
      },
    ];
    const outcome = ingestStrict(
      "sarif",
      JSON.stringify({ runs: [{ tool, results: [], invocations }] }),
    );
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.reportGap, "partial");
  });
});

describe("parseSarif: severity, location and rule details", () => {
  const log = (results: unknown[], rules: unknown[] = [], name = "scanner") =>
    JSON.stringify({ runs: [{ tool: { driver: { name, rules } }, results }] });

  it("takes the severity from the result before the rule, and from the level when neither has a score", () => {
    const out = parseSarif(
      log(
        [
          { ruleId: "R1", level: "note", properties: { "security-severity": "9.8" } },
          { ruleId: "R2", level: "note" },
          { ruleId: "R3", level: "error" },
          { ruleId: "R4", level: "warning" },
          { ruleId: "R5" },
        ],
        [
          { id: "R1", properties: { "security-severity": "1.0" } },
          { id: "R2", properties: { "security-severity": "7.5" } },
        ],
      ),
    );
    assert.deepEqual(
      out.map((f) => f.severity),
      ["critical", "high", "high", "medium", "low"],
    );
  });

  it("maps the score bands: 9 and up critical, 7 high, 4 medium, lower low", () => {
    const score = (s: string) =>
      parseSarif(log([{ ruleId: "X", properties: { "security-severity": s } }]))[0].severity;
    assert.deepEqual(
      [score("9"), score("7"), score("4"), score("3.9")],
      ["critical", "high", "medium", "low"],
    );
  });

  it("writes the location with a line, without a line, and without a uri", () => {
    const at = (loc: unknown) =>
      parseSarif(log([{ ruleId: "X", message: { text: "bad" }, locations: [loc] }]))[0].detail;
    assert.equal(
      at({ physicalLocation: { artifactLocation: { uri: "a.ts" }, region: { startLine: 7 } } }),
      "bad (a.ts:7)",
    );
    assert.equal(at({ physicalLocation: { artifactLocation: { uri: "a.ts" } } }), "bad (a.ts)");
    assert.equal(at({ physicalLocation: {} }), "bad");
  });

  it("names a finding after the tool and rule, with fallbacks for a missing tool, rule and message", () => {
    const out = parseSarif(JSON.stringify({ runs: [{ results: [{}] }] }));
    assert.equal(out[0].name, "sarif: (rule)");
    assert.equal(out[0].detail, "(rule)");
    assert.equal(out[0].status, "fail");
    assert.equal(out[0].category, "exposure");
  });

  it("cites a CWE from the rule's tags and keeps runs apart", () => {
    const out = parseSarif(
      JSON.stringify({
        runs: [
          {
            tool: {
              driver: {
                name: "one",
                rules: [{ id: "A", properties: { tags: ["external/cwe/cwe-89"] } }],
              },
            },
            results: [{ ruleId: "A" }],
          },
          { tool: { driver: { name: "two" } }, results: [{ ruleId: "A" }] },
        ],
      }),
    );
    assert.equal(out[0].name, "one: A");
    assert.equal(out[0].rule?.id, "CWE-89");
    assert.equal(out[1].name, "two: A");
    assert.equal(out[1].rule, undefined);
  });
});

describe("parseSarif: result kind", () => {
  const log = (results: unknown[]) =>
    JSON.stringify({ runs: [{ tool: { driver: { name: "dast" } }, results }] });

  it("reads a pass, notApplicable or informational result as no failure", () => {
    const out = parseSarif(
      log([
        { ruleId: "checked-ok", kind: "pass", level: "none" },
        { ruleId: "not-relevant", kind: "notApplicable" },
        { ruleId: "fyi", kind: "informational", level: "note" },
      ]),
    );
    assert.deepEqual(out, []);
    const strict = ingestStrict("sarif", log([{ ruleId: "checked-ok", kind: "pass" }]));
    assert.ok(strict.ok && strict.findings.length === 0);
  });

  it("keeps fail, open (Nuclei marks every result open), review and an absent kind as failures", () => {
    const out = parseSarif(
      log([
        { ruleId: "a", kind: "fail", level: "error" },
        { ruleId: "b", kind: "open", level: "note" },
        { ruleId: "c", kind: "review" },
        { ruleId: "d" },
        { ruleId: "e", kind: "pass" },
      ]),
    );
    assert.deepEqual(
      out.map((f) => [f.name, f.status]),
      [
        ["dast: a", "fail"],
        ["dast: b", "fail"],
        ["dast: c", "fail"],
        ["dast: d", "fail"],
      ],
    );
  });
});
