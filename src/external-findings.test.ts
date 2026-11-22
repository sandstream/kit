import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs, {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseExternalFindings,
  externalFindingResults,
  checkExternalFindings,
  EXTERNAL_FINDINGS_FILE,
} from "./external-findings.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

describe("parseExternalFindings", () => {
  it("parses valid finding lines (case-insensitive severity, extra keys ignored)", () => {
    const text = [
      '{"source":"snyk","severity":"HIGH","id":"S-1","title":"t","package":"lodash","cvss":9}',
      '{"source":"sentrux","severity":"medium"}',
      "", // blank skipped
    ].join("\n");
    const { findings, malformed } = parseExternalFindings(text);
    assert.equal(malformed, 0);
    assert.equal(findings.length, 2);
    assert.equal(findings[0].severity, "high");
    assert.equal(findings[0].source, "snyk");
    assert.equal(findings[0].package, "lodash");
  });

  it("counts malformed lines (bad json / non-object / array / missing source / bad severity)", () => {
    const text = [
      "not json",
      '"a string"',
      "[1,2,3]",
      '{"severity":"high"}', // no source
      '{"source":"x","severity":"nope"}', // bad severity
      '{"source":"  ","severity":"high"}', // blank source
    ].join("\n");
    const { findings, malformed } = parseExternalFindings(text);
    assert.equal(findings.length, 0);
    assert.equal(malformed, 6);
  });
});

describe("externalFindingResults (no-false-green)", () => {
  it("FAILS a source with high/critical, WARNs medium/low, and never emits pass", () => {
    const results = externalFindingResults({
      findings: [
        { source: "snyk", severity: "high" },
        { source: "snyk", severity: "low" },
        { source: "aigis", severity: "medium" },
      ],
      malformed: 0,
    });
    const snyk = results.find((r) => r.name === "external: snyk");
    const aigis = results.find((r) => r.name === "external: aigis");
    assert.equal(snyk?.status, "fail"); // worst = high → fail
    assert.equal(snyk?.severity, "high");
    assert.match(snyk?.detail ?? "", /1 high, 1 low/);
    assert.equal(aigis?.status, "warn"); // only medium → warn
    assert.ok(!results.some((r) => r.status === "pass"), "ingestion can never produce a pass");
    // deterministic sort by source
    assert.deepEqual(
      results.map((r) => r.name),
      ["external: aigis", "external: snyk"],
    );
  });

  it("a forged status/pass key in the line cannot green the gate (only severity drives it)", () => {
    // A hostile emitter tries to sneak a pass through. parse ignores unknown keys;
    // the only lever is `severity`, and a critical severity FAILS regardless.
    const { findings } = parseExternalFindings(
      '{"source":"evil","severity":"critical","status":"pass","ok":true}',
    );
    const [r] = externalFindingResults({ findings, malformed: 0 });
    assert.equal(r.status, "fail");
    assert.equal(r.severity, "critical");
  });

  it("surfaces malformed lines as a low warn (never silent)", () => {
    const results = externalFindingResults({ findings: [], malformed: 3 });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "warn");
    assert.equal(results[0].didNotRun, true);
    assert.equal(results[0].evidenceStatus, "malformed");
    assert.match(results[0].detail, /3 unparseable/);
  });
});

describe("reference integration: the shipped kit-plugin-* emit shapes ingest cleanly", () => {
  // These mirror the exact lines kit-plugin-snyk/-wiz/-sentrux append to
  // .kit-scan-results.jsonl, so the contract stays wired to the real emitters.
  it("snyk / wiz / sentrux findings all parse (incl. wiz 'informational' → low)", () => {
    const lines = [
      // snyk: severity already critical|high|medium|low
      '{"timestamp":"t","source":"snyk","project":"p","severity":"high","id":"SNYK-1","title":"x","package":"lodash"}',
      // wiz: emits .toLowerCase() of INFORMATIONAL|LOW|…|CRITICAL — 'informational' must fold to low, not error
      '{"timestamp":"t","source":"wiz","severity":"informational","id":"W-1","title":"y"}',
      '{"timestamp":"t","source":"wiz","severity":"critical","id":"W-2"}',
      // sentrux: normalized to the four tiers + a hardcoded "high"
      '{"timestamp":"t","source":"sentrux","severity":"medium","title":"z"}',
    ].join("\n");
    const { findings, malformed } = parseExternalFindings(lines);
    assert.equal(malformed, 0, "no shipped-plugin line should be treated as malformed");
    assert.equal(findings.length, 4);
    const wizInfo = findings.find((f) => f.source === "wiz" && f.id === "W-1");
    assert.equal(wizInfo?.severity, "low", "wiz 'informational' folds to low");

    const results = externalFindingResults({ findings, malformed });
    assert.equal(results.find((r) => r.name === "external: wiz")?.status, "fail"); // has critical
    assert.equal(results.find((r) => r.name === "external: snyk")?.status, "fail"); // high
    assert.equal(results.find((r) => r.name === "external: sentrux")?.status, "warn"); // medium
  });

  it("accepts the common 'moderate' alias (npm/GitHub advisories) → medium", () => {
    const { findings, malformed } = parseExternalFindings(
      '{"source":"gh-advisory","severity":"moderate"}',
    );
    assert.equal(malformed, 0);
    assert.equal(findings[0].severity, "medium");
  });
});

describe("checkExternalFindings report paths", () => {
  it("returns [] when no results file is present (no-op)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-ext-"));
    try {
      assert.deepEqual(await checkExternalFindings(dir), []);
    } finally {
      rmTemp(dir);
    }
  });

  it("surfaces a directory at the report path as unsupported", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-ext-"));
    try {
      mkdirSync(join(dir, EXTERNAL_FINDINGS_FILE));
      const [gap] = await checkExternalFindings(dir);
      assert.equal(gap.status, "warn");
      assert.equal(gap.didNotRun, true);
      assert.equal(gap.evidenceStatus, "unsupported");
      assert.ok(!gap.detail.includes(dir));
    } finally {
      rmTemp(dir);
    }
  });

  it("reports an unavailable project path without echoing it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-ext-"));
    try {
      const [gap] = await checkExternalFindings(join(dir, "missing-project"));
      assert.equal(gap.status, "warn");
      assert.equal(gap.didNotRun, true);
      assert.equal(gap.evidenceStatus, "unavailable");
      assert.doesNotMatch(gap.detail, /missing-project/);
    } finally {
      rmTemp(dir);
    }
  });

  it("refuses live and dangling report links", { skip: process.platform === "win32" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-ext-"));
    try {
      writeFileSync(join(dir, "target"), '{"source":"snyk","severity":"high"}');
      for (const target of ["target", "missing"]) {
        const root = join(dir, target + "-root");
        mkdirSync(root);
        symlinkSync(join(dir, target), join(root, EXTERNAL_FINDINGS_FILE));
        const results = await checkExternalFindings(root);
        assert.equal(results.length, 1);
        assert.equal(results[0].status, "warn");
        assert.equal(results[0].didNotRun, true);
        assert.equal(results[0].evidenceStatus, "unsupported");
      }
    } finally {
      rmTemp(dir);
    }
  });
});

describe("checkExternalFindings report gaps", () => {
  it("distinguishes empty, malformed, unsupported and oversized configured reports", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-ext-"));
    const path = join(dir, EXTERNAL_FINDINGS_FILE);
    try {
      for (const [input, expected] of [
        ["", "missing"],
        [" \r\n\t", "missing"],
        ["bad record private-fixture-value", "malformed"],
        ['{\n  "bomFormat": "CycloneDX",\n  "components": []\n}', "unsupported"],
        ["", "partial"],
      ]) {
        writeFileSync(path, input);
        if (expected === "partial") truncateSync(path, 8 * 1024 * 1024 + 1);
        const results = await checkExternalFindings(dir);
        assert.equal(results.length, 1);
        const optional = expected === "missing";
        assert.equal(results[0].status, optional ? "skip" : "warn");
        assert.equal(results[0].didNotRun, optional ? undefined : true);
        assert.equal(results[0].scanIncomplete, optional ? undefined : true);
        assert.equal(results[0].evidenceStatus, expected);
        assert.ok(!results[0].detail.includes("private-fixture-value"));
      }
    } finally {
      rmTemp(dir);
    }
  });
});

describe("checkExternalFindings file changes", () => {
  it("classifies growth during the bounded read as stale", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "kit-ext-"));
    const path = join(dir, EXTERNAL_FINDINGS_FILE);
    writeFileSync(path, '{"source":"snyk","severity":"high"}');
    const read = fs.readSync;
    const spy = t.mock.method(
      fs,
      "readSync",
      (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
        appendFileSync(path, "\n");
        return read(fd, buffer, offset, length, position);
      },
    );
    syncBuiltinESMExports();
    try {
      const [gap] = await checkExternalFindings(dir);
      assert.equal(spy.mock.callCount(), 1);
      assert.equal(gap.status, "warn");
      assert.equal(gap.didNotRun, true);
      assert.equal(gap.evidenceStatus, "stale");
    } finally {
      spy.mock.restore();
      syncBuiltinESMExports();
      rmTemp(dir);
    }
  });

  it("keeps a parsed finding when the report entry is replaced at the same size", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "kit-ext-"));
    const path = join(dir, EXTERNAL_FINDINGS_FILE);
    const replacement = join(dir, "replacement");
    const line = '{"source":"snyk","severity":"critical"}';
    writeFileSync(path, line);
    writeFileSync(replacement, " ".repeat(line.length));
    const close = fs.closeSync;
    const spy = t.mock.method(fs, "closeSync", (fd: number) => {
      close(fd);
      renameSync(replacement, path);
    });
    syncBuiltinESMExports();
    try {
      const [finding, gap] = await checkExternalFindings(dir);
      assert.equal(spy.mock.callCount(), 1);
      assert.equal(finding.status, "fail");
      assert.equal(finding.hasFindings, true);
      assert.equal(gap.status, "warn");
      assert.equal(gap.didNotRun, true);
      assert.equal(gap.evidenceStatus, "stale");
    } finally {
      spy.mock.restore();
      syncBuiltinESMExports();
      rmTemp(dir);
    }
  });
});

it("reports a same-size rewrite of the same report entry as stale", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kit-ext-"));
  const path = join(dir, EXTERNAL_FINDINGS_FILE);
  const line = '{"source":"snyk","severity":"high"}';
  const beforeTime = new Date("2000-01-01");
  const afterTime = new Date("2001-01-01");
  writeFileSync(path, line);
  fs.utimesSync(path, beforeTime, beforeTime);
  const before = fs.statSync(path, { bigint: true });
  const close = fs.closeSync;
  const spy = t.mock.method(fs, "closeSync", (fd: number) => {
    close(fd);
    const writer = fs.openSync(path, "r+");
    try {
      fs.writeSync(writer, " ".repeat(line.length), 0, "utf8");
    } finally {
      close(writer);
    }
    fs.utimesSync(path, afterTime, afterTime);
  });
  syncBuiltinESMExports();
  try {
    const [finding, gap] = await checkExternalFindings(dir);
    const after = fs.statSync(path, { bigint: true });
    assert.equal(before.ino, after.ino);
    assert.equal(before.size, after.size);
    assert.notEqual(before.mtimeNs, after.mtimeNs);
    assert.equal(finding.hasFindings, true);
    assert.equal(gap.evidenceStatus, "stale");
    assert.equal(gap.didNotRun, true);
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
    rmTemp(dir);
  }
});

describe("checkExternalFindings legacy records", () => {
  it("accepts older JSONL producers without a timestamp or final LF, with unverified coverage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-ext-"));
    try {
      writeFileSync(
        join(dir, EXTERNAL_FINDINGS_FILE),
        [
          '{"source":"in-house.scanner","severity":"informational"}',
          '{"source":"in-house.scanner","severity":"low","timestamp":"2000-01-01T00:00:00Z"}',
        ].join("\r\n"),
      );
      const [finding] = await checkExternalFindings(dir);
      assert.equal(finding.name, "external: in-house.scanner");
      assert.equal(finding.status, "warn");
      assert.equal(finding.didNotRun, undefined);
      assert.equal(finding.hasFindings, true);
      assert.equal(finding.evidenceStatus, "partial");
      assert.match(finding.detail, /2 low/);
      assert.match(finding.detail, /completeness and freshness/);
    } finally {
      rmTemp(dir);
    }
  });

  it("ingests a partner-written results file into per-source results", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-ext-"));
    try {
      const unsafeSource = "private-label\n\u001b[31m";
      const finding = JSON.stringify({
        source: unsafeSource,
        severity: "low",
        title: "private-title",
        package: "private-package",
        id: "private-id",
      });
      writeFileSync(
        join(dir, EXTERNAL_FINDINGS_FILE),
        Buffer.concat([
          Buffer.from('{"source":"snyk","severity":"critical"}\ngarbage private-record\n'),
          Buffer.from([0xff, 0x0a]),
          Buffer.from(finding),
        ]),
      );
      const results = await checkExternalFindings(dir);
      const snyk = results.find((r) => r.name === "external: snyk");
      assert.equal(snyk?.status, "fail");
      assert.equal(snyk?.severity, "critical");
      assert.equal(snyk?.hasFindings, true);
      assert.ok(results.some((r) => r.hasFindings && r.severity === "low"));
      const gap = results.find((r) => r.name === "external findings (parse)");
      assert.equal(gap?.status, "warn");
      assert.equal(gap?.didNotRun, true);
      assert.equal(gap?.evidenceStatus, "partial");
      assert.match(gap?.detail ?? "", /2 unparseable/);
      assert.doesNotMatch(JSON.stringify(results), /private-|\\u001b/);
    } finally {
      rmTemp(dir);
    }
  });
});
