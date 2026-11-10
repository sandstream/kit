import assert from "node:assert/strict";
import { test } from "node:test";
import { scanProtocolFixture } from "./standards-javascript-protocol.test-support.js";

const source =
  "// private_source_marker\nfunction decide(flag) {\n  if (flag) return 1;\n  return 0;\n}\n";
const files = { "input.ts": source, "other.js": "export const ready = true;\n" };

function rejectsReport(fault: string): void {
  const result = scanProtocolFixture(files, fault);
  assert.equal(result.didNotRun, true, JSON.stringify(result));
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.files, ["input.ts", "other.js"]);
  assert.match(result.issue ?? "", /incomplete/i);
  assert.doesNotMatch(JSON.stringify(result), /private_source_marker/);
}

test("binds a complete compiler report to every requested source", () => {
  const result = scanProtocolFixture(files);
  assert.equal(result.didNotRun, false, result.issue);
  assert.deepEqual(result.files, ["input.ts", "other.js"]);
  assert.deepEqual(
    result.findings.map(({ file, fn, ccn, length }) => [file, fn, ccn, length]),
    [
      ["input.ts", "<module>", 1, 5],
      ["input.ts", "decide", 2, 4],
      ["other.js", "<module>", 1, 1],
    ],
  );
});

test("rejects a report bound to different source bytes", () => {
  rejectsReport('report.files[0].sha256 = "0".repeat(64);');
});

for (const [name, fault] of [
  ["omits the source prefix", "module.start = 25; module.length = 4;"],
  ["omits the source suffix", "module.end = 24; module.length = 1;"],
  ["has an empty module for nonempty source", "module.end = 0; module.length = 1;"],
]) {
  test(`rejects a compiler report that ${name}`, () => {
    rejectsReport(
      `const module = report.files[0].bodies.find(body => body.kind === "module"); ${fault}`,
    );
  });
}

for (const [name, fault] of [
  [
    "a second module with a distinct identity",
    'file.bodies.push({ ...module, id: "other-module" });',
  ],
  ["an inflated module length", "module.length = 999;"],
  ["an understated module length", "module.length = 1;"],
  ["an inflated function length", "fn.length = 999;"],
  ["an understated function length", "fn.length = 1;"],
  ["a decision at the exclusive function end", "fn.decisions = [fn.end]; fn.ccn = 2;"],
  ["a decision at the exclusive module end", "module.decisions = [module.end]; module.ccn = 2;"],
  ["an empty executable body", "fn.end = fn.start; fn.length = 1; fn.decisions = []; fn.ccn = 1;"],
]) {
  test(`rejects ${name} without returning partial findings`, () => {
    rejectsReport(`const file = report.files[0];
const module = file.bodies.find(body => body.kind === "module");
const fn = file.bodies.find(body => body.kind === "function");
${fault}`);
  });
}

for (const [name, fault] of [
  ["missing file", "report.files.pop();"],
  ["duplicate file replacing another input", "report.files[1] = report.files[0];"],
  ["unexpected file path", 'report.files[0].path = "unknown.ts";'],
  [
    "missing module",
    'report.files[0].bodies = report.files[0].bodies.filter(body => body.kind !== "module");',
  ],
  ["duplicate body identity", "report.files[0].bodies.push(report.files[0].bodies[1]);"],
  ["decision before its body", "report.files[0].bodies[1].decisions = [0];"],
  [
    "duplicate decision",
    "report.files[0].bodies[1].decisions = [50, 50]; report.files[0].bodies[1].ccn = 3;",
  ],
  ["inconsistent complexity", "report.files[0].bodies[1].ccn = 100;"],
  ["rejected last input", 'report.files[1].status = "invalid";'],
  ["compiler diagnostic", "report.files[0].diagnostics = [{ start: 0, length: 1, code: 1000 }];"],
  ["incomplete report", "report.complete = false;"],
  ["failed calibration", "report.calibration = false;"],
  ["unexpected compiler version", 'report.engine.version = "0.0.0";'],
  ["unexpected metric version", 'report.metricVersion = "unknown";'],
]) {
  test(`rejects a ${name}`, () => rejectsReport(fault));
}

test("accepts complete files in a different order with opaque body identities", () => {
  const result = scanProtocolFixture(
    files,
    `report.files.reverse();
for (const file of report.files) {
  file.bodies.reverse();
  file.bodies.forEach((body, index) => { body.id = "opaque-" + index; });
}`,
  );
  assert.equal(result.didNotRun, false, result.issue);
  assert.equal(result.findings.length, 3);
});

for (const [name, newline] of [
  ["LF", "\n"],
  ["CRLF", "\r\n"],
  ["CR", "\r"],
  ["Unicode line separator", "\u2028"],
  ["Unicode paragraph separator", "\u2029"],
]) {
  test(`accepts physical line lengths with ${name} and UTF-16 offsets`, () => {
    const text = [
      'const emoji = "😀";',
      "function decide(flag) {",
      "  return flag ? 1 : 0;",
      "}",
      "",
    ].join(newline);
    const result = scanProtocolFixture({ "input.ts": text });
    assert.equal(result.didNotRun, false, result.issue);
    assert.deepEqual(
      result.findings.map(({ fn, length }) => [fn, length]),
      [
        ["<module>", 4],
        ["decide", 3],
      ],
    );
  });
}

for (const [name, text, length] of [
  ["empty source", "", 1],
  ["one blank line", "\n", 1],
  ["two blank lines", "\r\n\r\n", 2],
  ["spaces", "  ", 1],
  ["an unterminated final line", "// comment\nconst value = 1;", 2],
] as const) {
  test(`accepts the module span for ${name}`, () => {
    const result = scanProtocolFixture({ "input.ts": text });
    assert.equal(result.didNotRun, false, result.issue);
    assert.deepEqual(
      result.findings.map(({ kind, length: lines }) => [kind, lines]),
      [["module", length]],
    );
  });
}
