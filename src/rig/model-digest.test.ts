import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFindings, validateRow, type RunMark } from "./findings.js";
import { instrumentsOf } from "./instruments.js";
import { renderReport } from "./render.js";
import type { RigResult } from "./store.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER = `sha256:${"b".repeat(64)}`;

const ROW = {
  run: "r1",
  config: "A",
  target: "d1",
  file: "src/auth.ts",
  line: 41,
  claim: "token is not checked",
  severity: "high",
  model: "some-model",
  model_version: "latest",
  date: "2026-10-31",
};

const jsonl = (...rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join("\n");

describe("model_digest on an ingest row (ADR-0007: recorded, never adjudicated)", () => {
  it("is optional: a row without it is accepted unchanged", () => {
    const f = validateRow(ROW);
    assert.ok(typeof f !== "string");
    assert.equal("model_digest" in f, false);
  });

  it("is accepted on a finding, a none row and a failed row, and carried into the run", () => {
    const { file: _f, line: _l, claim: _c, severity: _s, ...mark } = ROW;
    for (const row of [
      { ...ROW, model_digest: DIGEST },
      { ...mark, none: true, model_digest: DIGEST },
      { ...mark, failed: "timeout", model_digest: DIGEST },
    ]) {
      const v = validateRow(row);
      assert.ok(typeof v !== "string", `refused: ${String(v)}`);
      assert.equal(v.model_digest, DIGEST);
    }
    assert.equal(
      parseFindings(jsonl({ ...ROW, model_digest: DIGEST })).runs[0].model_digest,
      DIGEST,
    );
  });

  it("accepts a provider snapshot id as well as a content hash", () => {
    const v = validateRow({ ...ROW, model_digest: "snapshot:some-model-2026-10-01" });
    assert.ok(typeof v !== "string", String(v));
  });

  it("is validated for shape, never interpreted", () => {
    const bad = [
      "",
      "a".repeat(64),
      "sha256:xyz",
      `sha256:${"a".repeat(63)}`,
      `sha512:${"a".repeat(64)}`,
      "snap shot:x",
      "snapshot:has space",
      `snapshot:${"x".repeat(300)}`,
      42,
    ];
    for (const d of bad) {
      assert.match(
        String(validateRow({ ...ROW, model_digest: d })),
        /"model_digest" must be/,
        `accepted ${JSON.stringify(d)}`,
      );
    }
  });

  it("refuses one run of one target declared with two different digests", () => {
    const { errors } = parseFindings(
      jsonl({ ...ROW, model_digest: DIGEST }, { ...ROW, line: 50, model_digest: OTHER }),
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /model_digest/);
  });
});

const mark = (run: string, config: string, digest?: string): RunMark => ({
  run,
  config,
  target: "d1",
  model: "some-model",
  model_version: "latest",
  date: "2026-10-31",
  ...(digest ? { model_digest: digest } : {}),
});

describe("the report shows the declared instruments", () => {
  const base: RigResult = {
    inputId: "9".repeat(64),
    adjudicatedAt: "2026-10-31T00:00:00.000Z",
    outcomes: [],
    unknownTargets: [],
    stats: [],
    warnings: [],
    receipt: { inputId: "9".repeat(64), findings: [], summary: {}, signature: null },
  };

  it("prints each instrument and the self-declared limit when a digest is present", () => {
    const out = renderReport(
      { ...base, instruments: instrumentsOf([mark("r1", "A", DIGEST)]) },
      [],
    ).join("\n");
    assert.match(out, /Instruments \(declared by the caller\):/);
    assert.match(out, new RegExp(`A +some-model latest +${DIGEST} +1 run\\(s\\)`));
    assert.match(out, /self-declared: kit did not run the model/);
  });

  it("prints no digest line for a result written before model_digest existed", () => {
    const out = renderReport(base, []).join("\n");
    assert.doesNotMatch(out, /Instruments/);
    assert.doesNotMatch(out, /self-declared/);
  });
});
