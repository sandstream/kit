import assert from "node:assert/strict";
import { it } from "node:test";
import { requestFile, runWorker } from "./standards-javascript-worker.test-support.js";

const file = requestFile("input.ts", "function choose(x) { if(x) return 1; return 0; }");

it("the helper accepts a complete request and returns measured syntax without source execution", () => {
  const result = runWorker({ version: 1, files: [file] });
  assert.equal(result.exit, 0);
  assert.equal(result.report.complete, true);
  assert.equal(result.report.files[0].sha256, file.sha256);
  assert.equal(result.report.files[0].bodies.find((body) => body.name === "choose")?.ccn, 2);
});

for (const [name, request] of [
  ["wrong version", { version: 2, files: [file] }],
  ["missing source field", { version: 1, files: [{ path: file.path, sha256: file.sha256 }] }],
  ["wrong content hash", { version: 1, files: [{ ...file, sha256: "0".repeat(64) }] }],
  ["duplicate paths", { version: 1, files: [file, file] }],
  ["unknown envelope field", { version: 1, files: [file], trusted: true }],
] as const) {
  it(`the helper rejects a request with ${name}`, () => {
    const result = runWorker(request);
    assert.equal(result.exit, 1);
    assert.equal(result.report.complete, false);
    assert.deepEqual(result.report.files, []);
  });
}

it("a rejected source prevents complete batch evidence and does not disclose its text", () => {
  const result = runWorker({
    version: 1,
    files: [file, requestFile("broken.ts", "function private_source_marker( {")],
  });
  assert.equal(result.exit, 1);
  assert.equal(result.report.complete, false);
  assert.deepEqual(
    result.report.files.map((entry) => entry.status),
    ["complete", "invalid"],
  );
  assert.ok(result.report.files[1].diagnostics.length > 0);
  assert.deepEqual(result.report.files[1].bodies, []);
  assert.doesNotMatch(result.stdout, /private_source_marker/);
});
