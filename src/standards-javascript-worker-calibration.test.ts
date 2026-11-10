import assert from "node:assert/strict";
import { it } from "node:test";
import { requestFile, runWorker } from "./standards-javascript-worker.test-support.js";

const request = { version: 1, files: [requestFile("input.ts", "const value = 1;")] };

it("the actual compiler passes calibration before source measurement", () => {
  const result = runWorker(request);
  assert.equal(result.exit, 0);
  assert.equal(result.report.calibration, true);
  assert.equal(result.report.complete, true);
});

it("a compiler that omits child syntax cannot pass calibration", () => {
  const result = runWorker(request, "module.exports.forEachChild = () => undefined;");
  assert.equal(result.exit, 1);
  assert.equal(result.report.calibration, false);
  assert.equal(result.report.complete, false);
  assert.deepEqual(result.report.files, []);
});

it("an unsupported compiler version cannot produce approved evidence", () => {
  const result = runWorker(request, "module.exports.version = '0.0.0';");
  assert.equal(result.exit, 1);
  assert.equal(result.report.complete, false);
  assert.equal(result.report.calibration, false);
});

it("missing parser diagnostics cannot be treated as valid source", () => {
  const result = runWorker(
    request,
    `const parse = module.exports.createSourceFile;
module.exports.createSourceFile = (...args) => {
  const source = parse(...args);
  delete source.parseDiagnostics;
  return source;
};`,
  );
  assert.equal(result.exit, 1);
  assert.equal(result.report.calibration, false);
  assert.equal(result.report.complete, false);
});
