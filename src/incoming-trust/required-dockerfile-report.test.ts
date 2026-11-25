import assert from "node:assert/strict";
import { it } from "node:test";
import {
  finishRequiredDockerfileInspection,
  requiredDockerfilePaths,
} from "./required-dockerfile-report.js";
import type { IncomingSnapshotEntry } from "./snapshot-format.js";

const files = new Set(["Dockerfile", "app/Dockerfile.dev"]);
const report = { schema: "kit.dockerfile-inspection/v1", scanned: [...files], hits: [] };
const launch = {
  ran: true as const,
  runId: "fixture-run",
  inputDigest: "fixture-digest",
  code: 0,
  outcome: "exited" as const,
  stdout: JSON.stringify(report),
  stderr: "worker diagnostic",
};

it("uses regular signed entries for the inspector and the Dockerfile coverage list", () => {
  const entry = (path: string): IncomingSnapshotEntry => ({
    path,
    kind: "file",
    size: 0,
    sha256: "0".repeat(64),
    executable: false,
  });
  const signed = [entry("main.mjs"), entry("Dockerfile"), entry("node_modules/tool/Dockerfile")];
  assert.deepEqual(requiredDockerfilePaths(signed, "main.mjs"), new Set(["Dockerfile"]));
  assert.equal(requiredDockerfilePaths(signed, "missing.mjs"), undefined);
  const linked: IncomingSnapshotEntry = {
    path: "app/Dockerfile",
    kind: "symlink",
    target: "../Dockerfile",
  };
  assert.equal(requiredDockerfilePaths([...signed, linked], "main.mjs"), undefined);
});

it("uses complete evidence without exposing raw worker output", () => {
  const passed = finishRequiredDockerfileInspection(launch, files);
  assert.equal(passed.ran, true);
  if (!passed.ran) return;
  assert.equal(passed.requiredCheck?.status, "pass");
  assert.equal(passed.stdout + passed.stderr, "");

  const hit = { file: "Dockerfile", line: 2, indicator: "APP_TOKEN" };
  const failed = finishRequiredDockerfileInspection(
    { ...launch, stdout: JSON.stringify({ ...report, hits: [hit] }) },
    files,
  );
  assert.equal(failed.ran, true);
  if (!failed.ran) return;
  assert.equal(failed.outcome, "check-failed");
  assert.equal(failed.requiredCheck?.status, "fail");
  assert.deepEqual(failed.requiredCheck?.files, ["Dockerfile"]);
});

it("refuses incompatible, incomplete or malformed reports", () => {
  const outputs = [
    "",
    JSON.stringify({ ...report, schema: "kit.dockerfile-inspection/v2" }),
    JSON.stringify({ ...report, scanned: ["Dockerfile"] }),
    JSON.stringify({ ...report, scanned: ["Dockerfile", "Dockerfile"] }),
    JSON.stringify({ ...report, scanError: true }),
    JSON.stringify({ ...report, hits: [{ file: "unknown", line: 1, indicator: "APP_TOKEN" }] }),
  ];
  for (const stdout of outputs) {
    const result = finishRequiredDockerfileInspection({ ...launch, stdout }, files);
    assert.equal(result.ran, true);
    if (!result.ran) continue;
    assert.equal(result.outcome, "check-failed");
    assert.equal(result.requiredCheck?.status, "fail");
    assert.equal(result.requiredCheck?.didNotRun, true);
  }
});

it("rejects a report after a crash, deadline, unavailable run or boundary failure", () => {
  const crash = { ...launch, code: 1 };
  const timeout = { ...launch, outcome: "timed-out" as const };
  const failedBoundary = { ...launch, outcome: "boundary-failed" as const };
  for (const run of [crash, timeout, failedBoundary]) {
    const result = finishRequiredDockerfileInspection(run, files);
    assert.equal(result.ran, true);
    if (!result.ran) continue;
    assert.equal(result.requiredCheck?.status, "fail");
    assert.equal(result.stdout + result.stderr, "");
  }
  const refused = { ran: false, reason: "unavailable" } as const;
  assert.deepEqual(finishRequiredDockerfileInspection(refused, files), refused);
});
