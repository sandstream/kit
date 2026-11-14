import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, it } from "node:test";
import { createCliContractFixture } from "../cli-contract.test-support.js";

let fixture: ReturnType<typeof createCliContractFixture>;
beforeEach(() => {
  fixture = createCliContractFixture();
});
afterEach(() => fixture.cleanup());

function report(content: unknown, name = "report.json") {
  writeFileSync(join(fixture.cwd, name), JSON.stringify(content));
  return name;
}

for (const format of ["sarif", "osv"] as const) {
  it(`${format}: rejects malformed JSON instead of reporting zero findings`, () => {
    writeFileSync(join(fixture.cwd, "report.json"), "invalid public-fixture-secret");
    const before = fixture.snapshot();
    const result = fixture.run(["ingest", format, "report.json", "--json"]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /invalid JSON|not valid JSON/);
    assert.doesNotMatch(result.stdout + result.stderr, /public-fixture-secret/);
    assert.deepEqual(fixture.snapshot(), before);
  });

  it(`${format}: rejects an unrelated JSON object`, () => {
    const result = fixture.run([
      "ingest",
      format,
      report({ error: "public-fixture-secret" }),
      "--json",
    ]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /public-fixture-secret/);
  });

  it(`${format}: rejects malformed nested collections with a useful diagnostic`, () => {
    const data = format === "sarif" ? { runs: [{ results: {} }] } : { results: [{ packages: {} }] };
    const result = fixture.run(["ingest", format, report(data), "--json"]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /invalid|not a|expected/i);
    assert.doesNotMatch(result.stderr, /unexpected|TypeError|at .*\.ts:/);
  });

  it(`${format}: rejects extra positional data`, () => {
    const data = format === "sarif" ? { runs: [] } : { results: [] };
    const result = fixture.run(["ingest", format, report(data), "ignored.json", "--json"]);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /usage:/i);
  });

  it(`${format}: handles a separate global environment value before the format`, () => {
    const data = format === "sarif" ? { runs: [] } : { results: [] };
    const result = fixture.run(["ingest", "--env", "staging", format, report(data), "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { count: 0, findings: [] });
  });
}

it("does not echo a sensitive filename in a read diagnostic", () => {
  const result = fixture.run(["ingest", "sarif", "public-fixture-secret.json", "--json"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /could not read/i);
  assert.doesNotMatch(result.stdout + result.stderr, /public-fixture-secret/);
});

const sarif = {
  version: "2.1.0",
  runs: [
    {
      tool: {
        driver: {
          name: "public-scanner",
          rules: [{ id: "R1", properties: { "security-severity": "9.1", tags: ["CWE-89"] } }],
        },
      },
      results: [
        { ruleId: "R2", level: "warning", message: { text: "Review fixture" } },
        {
          ruleId: "R1",
          message: { text: "SQL fixture" },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: "src/db.ts" },
                region: { startLine: 42 },
              },
            },
          ],
        },
      ],
    },
  ],
};
const osv = {
  results: [
    {
      packages: [
        {
          package: { name: "public-package", version: "1.0.0" },
          vulnerabilities: [
            {
              id: "PUBLIC-1",
              summary: "Dependency fixture",
              database_specific: { severity: "HIGH" },
            },
          ],
        },
      ],
    },
  ],
};

for (const [format, data, count] of [
  ["sarif", sarif, 2],
  ["osv", osv, 1],
] as const) {
  it(`${format}: imports valid findings repeatedly without writes or config`, () => {
    const file = report(data, "report with spaces.json");
    rmSync(join(fixture.cwd, ".kit.toml"));
    const before = fixture.snapshot();
    const results = [
      fixture.run(["ingest", format, file, "--json"]),
      fixture.run(["ingest", format, file, "--json"]),
    ];
    for (const result of results) {
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.count, count);
      assert.equal(output.findings.length, count);
      assert.ok(output.findings.every((finding: { status: string }) => finding.status === "fail"));
      assert.match(result.stderr, /external.*report|scanner.*report/i);
      assert.match(result.stderr, /not.*(verify|proof)/i);
      if (format === "sarif") {
        assert.equal(output.findings[1].severity, "critical");
        assert.equal(output.findings[1].rule.id, "CWE-89");
        assert.equal(output.findings[1].detail, "SQL fixture (src/db.ts:42)");
      } else {
        assert.equal(output.findings[0].name, "public-package@1.0.0: PUBLIC-1");
        assert.equal(output.findings[0].severity, "high");
        assert.equal(output.findings[0].rule.id, "OWASP-A06");
      }
    }
    assert.equal(results[0].stdout, results[1].stdout);
    assert.deepEqual(fixture.snapshot(), before);
  });

  it(`${format}: imports reports with network entry points blocked`, () => {
    const preload = join(fixture.root, "ingest-block-network.mjs");
    writeFileSync(
      preload,
      `
import ${JSON.stringify(import.meta.resolve("tsx"))};
import net from 'node:net';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';
const deny = () => { process.stderr.write('ingest network tripwire\\n'); process.exit(86); };
globalThis.fetch = deny;
net.Socket.prototype.connect = deny;
dns.lookup = dns.resolve = dns.promises.lookup = dns.promises.resolve = deny;
http.request = http.get = https.request = https.get = http2.connect = deny;
dgram.createSocket = deny;
syncBuiltinESMExports();
`,
    );
    fixture.env.NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`;
    const file = report(data);
    const before = fixture.snapshot();
    const result = fixture.run(["ingest", format, file, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).count, count);
    assert.deepEqual(fixture.snapshot(), before);
    // Interactive text output must also honor ADR-0009 when update checks are enabled.
    delete fixture.env.CI;
    delete fixture.env.KIT_NON_INTERACTIVE;
    delete fixture.env.KIT_NO_UPDATE_CHECK;
    const interactive = fixture.run(["ingest", format, file]);
    assert.equal(interactive.status, 0, interactive.stderr);
    assert.match(interactive.stdout, /finding\(s\)/);
    assert.deepEqual(fixture.snapshot(), before);
    for (const probe of [
      "fetch('http://127.0.0.1:9')",
      "require('node:net').connect(9)",
      "require('node:dns').lookup('example.invalid')",
      "require('node:https').get('https://example.invalid')",
    ]) {
      const control = spawnSync(process.execPath, ["-e", probe], {
        env: fixture.env,
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.ifError(control.error);
      assert.equal(control.status, 86, control.stderr);
      assert.match(control.stderr, /ingest network tripwire/);
    }
  });

  it(`${format}: keeps active read-only mode free of report and home writes`, () => {
    fixture.env.KIT_READ_ONLY = "1";
    const file = report(data);
    const before = fixture.snapshot();
    const result = fixture.run(["--read-only", "ingest", format, file, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).count, count);
    assert.deepEqual(fixture.snapshot(), before);
  });

  it(`${format}: records only global audit artifacts when read-only mode activates`, () => {
    const file = report(data);
    const before = fixture.snapshot();
    const result = fixture.run(["ingest", format, file, "--read-only", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).count, count);
    const after = fixture.snapshot();
    // Snapshot keys use the native separator, so build them with join.
    delete after[join("project", ".kit-audit.jsonl")];
    // Expected: audit activation needs its persistent coordination file. No report or home writes are allowed.
    const lock = lstatSync(join(fixture.cwd, ".kit-audit.jsonl.lock.sqlite"));
    assert.ok(lock.isFile());
    assert.equal(lock.nlink, 1);
    delete after[join("project", ".kit-audit.jsonl.lock.sqlite")];
    assert.deepEqual(after, before);
    const events = readFileSync(join(fixture.cwd, ".kit-audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.length, 1);
    assert.equal(events[0].operation, "read-only-mode-activated");
  });

  for (const data of format === "sarif"
    ? [{ runs: [] }, { runs: [{ tool: { driver: { name: "public-scanner" } }, results: [] }] }]
    : [
        { results: [] },
        { results: [{ packages: [{ package: { name: "public-package" }, vulnerabilities: [] }] }] },
      ]) {
    it(`${format}: accepts a legitimate empty report ${JSON.stringify(data)}`, () => {
      const result = fixture.run(["ingest", format, report(data), "--json"]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { count: 0, findings: [] });
    });
  }
}

for (const format of ["sarif", "osv"] as const) {
  for (const jsonMode of [false, true]) {
    it(`${format}: sanitizes external report fields in ${jsonMode ? "JSON" : "text"} output`, () => {
      const tokens = "abcdefgh".split("").map((letter) => `ghp_${letter.repeat(36)}`);
      const unsafe = (index: number) =>
        `fixture-${index}\x1b[2J\x9d52;c;terminal-payload\x9c\u202e${tokens[index]}`;
      const data =
        format === "sarif"
          ? {
              runs: [
                {
                  tool: { driver: { name: unsafe(0), rules: [{ id: unsafe(1) }] } },
                  results: [
                    {
                      ruleId: unsafe(1),
                      message: { text: unsafe(2) },
                      locations: [{ physicalLocation: { artifactLocation: { uri: unsafe(3) } } }],
                    },
                  ],
                },
              ],
            }
          : {
              results: [
                {
                  packages: [
                    {
                      package: { name: unsafe(4), version: unsafe(5) },
                      vulnerabilities: [{ id: unsafe(6), summary: unsafe(7) }],
                    },
                  ],
                },
              ],
            };
      const result = fixture.run(["ingest", format, report(data), ...(jsonMode ? ["--json"] : [])]);
      assert.equal(result.status, 0, result.stderr);
      for (const token of tokens) assert.ok(!result.stdout.includes(token), token);
      assert.doesNotMatch(result.stdout, /terminal-payload/);
      assert.match(result.stdout, /\[REDACTED\]/);
      if (jsonMode) {
        const output = JSON.parse(result.stdout);
        assert.equal(output.count, 1);
        const finding = output.findings[0];
        assert.doesNotMatch(finding.name + finding.detail, /[\u0000-\u001f\u007f-\u009f\u202e]/);
      } else {
        const visible = result.stdout.replace(/\x1b\[(?:0|1|2|31|32|33|36)m/g, "");
        assert.doesNotMatch(visible, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202e]/);
      }
    });
  }
}

it("renders text findings by severity while JSON preserves report order", () => {
  const result = fixture.run(["ingest", "sarif", report(sarif)]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 finding\(s\)/);
  assert.ok(result.stdout.indexOf("CRITICAL") < result.stdout.indexOf("MEDIUM"));
  assert.match(result.stdout, /CWE-89/);
});

for (const [format, data] of [
  ["sarif", null],
  ["sarif", []],
  ["sarif", { runs: [null] }],
  ["sarif", { runs: [{ results: [null] }] }],
  ["sarif", { runs: [{ results: [{ message: { text: { unsafe: "public-fixture-secret" } } }] }] }],
  ["sarif", { runs: [{ tool: { driver: { rules: [null] } } }] }],
  ["sarif", { runs: [{ results: [{ level: 42 }] }] }],
  ["osv", 42],
  ["osv", []],
  ["osv", { results: [null] }],
  ["osv", { results: [{ packages: [null] }] }],
  ["osv", { results: [{ packages: [{ vulnerabilities: [null] }] }] }],
  [
    "osv",
    {
      results: [
        { packages: [{ vulnerabilities: [{ summary: { unsafe: "public-fixture-secret" } }] }] },
      ],
    },
  ],
  [
    "osv",
    { results: [{ packages: [{ vulnerabilities: [{ database_specific: { severity: 42 } }] }] }] },
  ],
] as const) {
  it(`${format}: refuses invalid report shape ${JSON.stringify(data)}`, () => {
    const result = fixture.run(["ingest", format, report(data), "--json"]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.match(output.error, /invalid|not a/i);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /public-fixture-secret|TypeError|\[object Object\]/,
    );
  });
}

for (const args of [
  [],
  ["sarif"],
  ["osv"],
  ["unknown", "report.json"],
  ["sarif", "report.json", "extra"],
  ["sarif", "report.json", "-x"],
]) {
  it(`refuses invalid arguments ${JSON.stringify(args)} without writes`, () => {
    report({ runs: [] });
    const before = fixture.snapshot();
    const result = fixture.run(["ingest", ...args, "--json"]);
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /usage:/i);
    assert.deepEqual(fixture.snapshot(), before);
  });
}

for (const args of [
  ["--env", "staging", "ingest", "sarif", "report.json"],
  ["--env=staging", "ingest", "sarif", "report.json"],
  ["ingest", "sarif", "--env", "staging", "report.json"],
  ["ingest", "sarif", "report.json", "--env", "staging"],
  ["ingest", "--env=staging", "sarif", "report.json"],
]) {
  it(`accepts global environment placement ${JSON.stringify(args)}`, () => {
    report({ runs: [] });
    const result = fixture.run([...args, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { count: 0, findings: [] });
  });
}

for (const [flag, status] of [
  ["--unknown=public-fixture-secret", 1],
  ["--json=true", 2],
  ["--dry-run", 2],
  ["--env=", 2],
] as const) {
  it(`refuses unsupported flag form ${flag} without import effects`, () => {
    const file = report({ runs: [] });
    const before = fixture.snapshot();
    const result = fixture.run(["ingest", "sarif", file, flag]);
    assert.equal(result.status, status, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /public-fixture-secret/);
    assert.deepEqual(fixture.snapshot(), before);
  });
}

it("reads a dash-prefixed filename after the option separator", () => {
  const file = report({ runs: [] }, "-report.json");
  const result = fixture.run(["ingest", "sarif", "--json", "--", file]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { count: 0, findings: [] });
});

for (const failure of ["missing", "directory", "permissions"] as const) {
  it(`reports a ${failure} read error without revealing the path`, (t) => {
    if (failure === "permissions" && (process.platform === "win32" || process.getuid?.() === 0)) {
      t.skip("POSIX file permissions require a non-root user.");
      return;
    }
    const file = join(fixture.cwd, "public-fixture-secret.json");
    if (failure === "directory") mkdirSync(file);
    if (failure === "permissions") {
      writeFileSync(file, "{}");
      chmodSync(file, 0o000);
    }
    try {
      const result = fixture.run(["ingest", "osv", file, "--json"]);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /could not read/i);
      assert.doesNotMatch(result.stdout + result.stderr, /public-fixture-secret/);
    } finally {
      if (failure === "permissions") chmodSync(file, 0o600);
    }
  });
}

const auditStep = (kind: string, file: string, line: number) => ({
  kind,
  file,
  line,
  scope: "fixture",
  description: "fixture",
});
const cloudflareAudit = [
  {
    verdict: "confirmed",
    fingerprint: "public-confirmed",
    title: "Confirmed fixture",
    trace: [auditStep("entrypoint", "src/a.ts", 1), auditStep("sink", "src/b.ts", 9)],
    severity: { overall_severity: "critical" },
  },
  {
    verdict: "needs_validation",
    fingerprint: "public-unverified",
    title: "Unverified fixture",
    trace: [auditStep("entrypoint", "src/c.ts", 3)],
  },
  {
    verdict: "rejected",
    fingerprint: "public-rejected",
    title: "Rejected fixture",
    trace: [auditStep("sink", "src/d.ts", 4)],
  },
];

it("cloudflare-audit: imports confirmed and unverified records and counts rejected ones", () => {
  const file = report(cloudflareAudit);
  const before = fixture.snapshot();
  const result = fixture.run(["ingest", "cloudflare-audit", file, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.count, 2);
  assert.deepEqual(
    output.findings.map((f: { status: string; severity: string }) => [f.status, f.severity]),
    [
      ["fail", "critical"],
      ["warn", "low"],
    ],
  );
  assert.equal(output.findings[0].detail, "Confirmed fixture (src/b.ts:9)");
  assert.doesNotMatch(result.stdout, /public-rejected/);
  assert.match(result.stderr, /1 candidate\(s\) the audit rejected were counted, not ingested/);
  assert.deepEqual(fixture.snapshot(), before);
});

it("cloudflare-audit: refuses a report kit cannot read instead of reporting it clean", () => {
  const result = fixture.run([
    "ingest",
    "cloudflare-audit",
    report([{ ...cloudflareAudit[0], severity: { overall_severity: "public-fixture-secret" } }]),
    "--json",
  ]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(JSON.parse(result.stdout).error, /invalid Cloudflare audit report/);
  assert.doesNotMatch(result.stdout + result.stderr, /public-fixture-secret/);
});
