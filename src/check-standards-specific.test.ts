import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseEslintJson,
  parseTscOutput,
  parseRuffJson,
  parseMypyOutput,
  parseGoVet,
  parseGofmtList,
  parseClippyShort,
  parseCargoFmtCheck,
  checkStandardsSpecific,
  scanSpecific,
  collectSpecificKeys,
  specificKey,
  SPECIFIC_LANGUAGES,
  type SpecificScanResult,
} from "./check-standards-specific.js";
import type { ExecResult } from "./utils/execFileNoThrow.js";

const ok = (stdout: string, exitCode = 0): ExecResult => ({
  stdout,
  stderr: "",
  exitCode,
  ok: exitCode === 0,
});
const err = (stderr: string, exitCode = 1): ExecResult => ({
  stdout: "",
  stderr,
  exitCode,
  ok: false,
});

describe("specific parsers — eslint", () => {
  it("flattens filePath + messages into findings", () => {
    const json = JSON.stringify([
      {
        filePath: "/repo/src/a.ts",
        messages: [
          { line: 3, ruleId: "no-unused-vars", message: "x is unused", severity: 2 },
          { line: 9, ruleId: "eqeqeq", message: "use ===", severity: 1 },
        ],
      },
      { filePath: "/repo/src/b.ts", messages: [] },
    ]);
    const f = parseEslintJson(ok(json));
    assert.equal(f.length, 2);
    assert.deepEqual(f[0], {
      file: "/repo/src/a.ts",
      line: 3,
      rule: "no-unused-vars",
      message: "x is unused",
    });
  });
  it("tolerates non-JSON", () => {
    assert.deepEqual(parseEslintJson(ok("boom")), []);
  });
});

describe("specific parsers — tsc", () => {
  it("parses `file(line,col): error TSxxxx: msg` (stdout or stderr)", () => {
    const out = [
      "src/x.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/y.ts(1,1): error TS1005: ';' expected.",
      "Found 2 errors.",
    ].join("\n");
    const f = parseTscOutput(ok(out, 2));
    assert.equal(f.length, 2);
    assert.deepEqual(f[0], {
      file: "src/x.ts",
      line: 12,
      rule: "TS2322",
      message: "Type 'string' is not assignable to type 'number'.",
    });
  });
});

describe("specific parsers — ruff", () => {
  it("maps filename/location.row/code", () => {
    const json = JSON.stringify([
      {
        filename: "app/m.py",
        location: { row: 4 },
        code: "F401",
        message: "os imported but unused",
      },
    ]);
    const f = parseRuffJson(ok(json, 1));
    assert.deepEqual(f, [
      { file: "app/m.py", line: 4, rule: "F401", message: "os imported but unused" },
    ]);
  });
});

describe("specific parsers — mypy", () => {
  it("parses `file:line: error: msg [code]`", () => {
    const out = [
      'm.py:10: error: Incompatible return value type (got "int", expected "str")  [return-value]',
      "m.py:12: error: Name 'x' is not defined",
      "Found 2 errors in 1 file",
    ].join("\n");
    const f = parseMypyOutput(ok(out, 1));
    assert.equal(f.length, 2);
    assert.equal(f[0].file, "m.py");
    assert.equal(f[0].line, 10);
    assert.equal(f[0].rule, "return-value");
    assert.equal(f[1].rule, undefined);
  });
});

describe("specific parsers — go vet + gofmt", () => {
  it("go vet parses `file:line:col: msg` from stderr", () => {
    const f = parseGoVet(err("main.go:7:2: unreachable code\nx.go:3:5: printf: wrong arg"));
    assert.equal(f.length, 2);
    assert.deepEqual(f[0], { file: "main.go", line: 7, message: "unreachable code" });
  });
  it("gofmt -l lists unformatted files", () => {
    const f = parseGofmtList(ok("main.go\ninternal/x.go\n"));
    assert.deepEqual(
      f.map((x) => x.file),
      ["main.go", "internal/x.go"],
    );
    assert.equal(f[0].rule, "gofmt");
  });
});

describe("specific parsers — clippy + rustfmt", () => {
  it("clippy short: `file:line:col: warning|error: msg`", () => {
    const out = [
      "src/main.rs:10:5: warning: unused variable: `y`",
      "src/lib.rs:3:1: error: mismatched types",
    ].join("\n");
    const f = parseClippyShort(err(out));
    assert.equal(f.length, 2);
    assert.deepEqual(f[0], { file: "src/main.rs", line: 10, message: "unused variable: `y`" });
  });
  it("cargo fmt --check: `Diff in <file> at line N` (deduped per file)", () => {
    const out = [
      "Diff in src/main.rs at line 5:",
      "-foo",
      "+foo;",
      "Diff in src/main.rs at line 22:",
      "Diff in src/lib.rs at line 1:",
    ].join("\n");
    const f = parseCargoFmtCheck(ok(out, 1));
    assert.deepEqual(
      f.map((x) => x.file),
      ["src/main.rs", "src/lib.rs"],
    );
    assert.equal(f[0].rule, "rustfmt");
  });
});

describe("specificKey", () => {
  it("prefers rule, falls back to line, then bare file", () => {
    assert.equal(
      specificKey("go", "vet", { file: "a.go", line: 5, rule: "printf" }),
      "go/vet:a.go#printf",
    );
    assert.equal(specificKey("go", "vet", { file: "a.go", line: 5 }), "go/vet:a.go:5");
    assert.equal(specificKey("go", "gofmt", { file: "a.go" }), "go/gofmt:a.go");
  });
});

describe("checkStandardsSpecific — gating", () => {
  const scan: SpecificScanResult = {
    language: "go",
    runs: [
      {
        spec: { id: "vet", label: "go vet" },
        findings: [{ file: `${process.cwd()}/main.go`, line: 7, message: "unreachable" }],
        didNotRun: false,
      },
      {
        spec: { id: "gofmt", label: "gofmt -l" },
        findings: [],
        didNotRun: false,
      },
    ],
  };

  it("passes a clean linter, warns net-new by default", async () => {
    const r = await checkStandardsSpecific({ language: "go", scan });
    const vet = r.find((x) => x.name.includes("go vet"));
    const fmt = r.find((x) => x.name.includes("gofmt"));
    assert.equal(fmt?.status, "pass");
    assert.equal(vet?.status, "warn");
    assert.match(vet?.files?.[0] ?? "", /main\.go:7/);
  });

  it("fails net-new under --enforce", async () => {
    const r = await checkStandardsSpecific({ language: "go", scan, enforce: true });
    assert.equal(r.find((x) => x.name.includes("go vet"))?.status, "fail");
  });

  it("baseline-frozen finding downgrades to a low warn (never fails)", async () => {
    const r = await checkStandardsSpecific({
      language: "go",
      scan,
      enforce: true,
      baseline: [specificKey("go", "vet", { file: "main.go", line: 7 })],
    });
    const vet = r.find((x) => x.name.includes("go vet"));
    assert.equal(vet?.status, "warn");
    assert.equal(vet?.severity, "low");
  });

  it("a missing linter is a setup gap: warn default, fail under enforce", async () => {
    const gap: SpecificScanResult = {
      language: "rust",
      runs: [{ spec: { id: "clippy", label: "cargo clippy" }, findings: [], didNotRun: true }],
    };
    assert.equal((await checkStandardsSpecific({ language: "rust", scan: gap }))[0].status, "warn");
    assert.equal(
      (await checkStandardsSpecific({ language: "rust", scan: gap, enforce: true }))[0].status,
      "fail",
    );
  });
});

describe("scanSpecific + collectSpecificKeys", () => {
  it("an unsupported language yields no runs", async () => {
    const s = await scanSpecific(process.cwd(), "haskell");
    assert.deepEqual(s.runs, []);
    assert.deepEqual(await collectSpecificKeys(process.cwd(), "haskell"), []);
  });
  it("disabled linters are skipped via the toggle map", async () => {
    // eslint/tsc absent in this env → didNotRun; disabling both leaves no runs at all.
    const s = await scanSpecific(process.cwd(), "typescript", { eslint: false, tsc: false });
    assert.deepEqual(s.runs, []);
  });
  it("exposes the four P2 languages", () => {
    assert.deepEqual([...SPECIFIC_LANGUAGES].sort(), ["go", "python", "rust", "typescript"]);
  });
});
