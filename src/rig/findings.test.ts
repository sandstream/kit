import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FindingsRefused, ingestFindings, parseFindings, runKey, validateRow } from "./findings.js";

const ROW = {
  run: "r1",
  config: "A",
  target: "d1",
  file: "src/auth.ts",
  line: 41,
  claim: "token is not checked",
  severity: "high",
  model: "some-model",
  model_version: "2026-10",
  date: "2026-10-31",
};

const NONE = {
  run: "r2",
  config: "A",
  target: "c1",
  none: true,
  model: "some-model",
  model_version: "2026-10",
  date: "2026-10-31",
};

const jsonl = (...rows: unknown[]): string =>
  rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n");

describe("validateRow", () => {
  it("accepts a complete row and normalises the file path", () => {
    const f = validateRow({ ...ROW, file: ".\\src\\auth.ts" });
    assert.ok(typeof f !== "string" && "file" in f);
    assert.equal(f.file, "src/auth.ts");
  });

  it("accepts a none row as a bare run mark", () => {
    const m = validateRow(NONE);
    assert.ok(typeof m !== "string");
    assert.equal("file" in m, false);
    assert.equal(m.target, "c1");
  });

  it("names the first problem in a row", () => {
    assert.equal(validateRow([1]), "row is not a JSON object");
    assert.equal(validateRow({ ...ROW, extra: 1 }), "unknown key(s) extra");
    assert.equal(validateRow({ ...ROW, run: "" }), '"run" must be a non-empty string');
    const { target: _t, ...noTarget } = ROW;
    assert.equal(validateRow(noTarget), '"target" must be a non-empty string');
    assert.equal(validateRow({ ...ROW, line: 0 }), '"line" must be a positive integer');
    assert.equal(validateRow({ ...ROW, line: 4.5 }), '"line" must be a positive integer');
    assert.match(
      validateRow({ ...ROW, severity: "urgent" }) as string,
      /"severity" must be one of critical/,
    );
    assert.match(
      validateRow({ ...ROW, date: "yesterday" }) as string,
      /"date" must be an ISO date/,
    );
    assert.match(validateRow({ ...ROW, file: "../etc/passwd" }) as string, /must not contain \.\./);
    assert.match(validateRow({ ...ROW, file: "/abs/x.ts" }) as string, /must be relative/);
  });

  it("refuses a none row that also carries a location, or none other than true", () => {
    assert.equal(validateRow({ ...NONE, file: "a.ts" }), "unknown key(s) file");
    assert.equal(validateRow({ ...NONE, none: false }), '"none" must be true when present');
  });
});

describe("parseFindings", () => {
  it("reports every malformed row with its line number and never drops one silently", () => {
    const text = jsonl(ROW, "", "{not json", { ...ROW, line: -1 }, { ...ROW, run: "r3" });
    const { findings, errors } = parseFindings(text);
    assert.deepEqual(
      findings.map((f) => f.run),
      ["r1", "r3"],
    );
    assert.deepEqual(errors, [
      { line: 3, message: "not valid JSON" },
      { line: 4, message: '"line" must be a positive integer' },
    ]);
  });

  it("lists every run once, including runs with no finding", () => {
    const { runs, findings } = parseFindings(jsonl(ROW, { ...ROW, line: 50 }, NONE));
    assert.equal(findings.length, 2);
    assert.deepEqual(runs.map(runKey), [runKey(ROW), runKey(NONE)]);
  });

  it("reads CRLF files the same as LF files", () => {
    const lf = parseFindings(jsonl(ROW, NONE));
    const crlf = parseFindings(jsonl(ROW, NONE).replace(/\n/g, "\r\n"));
    assert.deepEqual(crlf, lf);
  });
});

describe("ingestFindings", () => {
  it("keeps the good rows when lenient and refuses the whole file when strict", () => {
    const text = jsonl(ROW, { ...ROW, severity: "x" });
    assert.equal(ingestFindings(text).findings.length, 1);
    assert.throws(
      () => ingestFindings(text, { strict: true }),
      (e: unknown) => e instanceof FindingsRefused && /first at line 2/.test(e.message),
    );
    assert.equal(ingestFindings(jsonl(ROW), { strict: true }).errors.length, 0);
  });
});
