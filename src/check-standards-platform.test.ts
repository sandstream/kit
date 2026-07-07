import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseHadolintJson,
  findDockerfiles,
  checkStandardsPlatform,
  platformKey,
  type PlatformScan,
} from "./check-standards-platform.js";
import type { ExecResult } from "./utils/execFileNoThrow.js";

const ok = (stdout: string, exitCode = 0): ExecResult => ({
  stdout,
  stderr: "",
  exitCode,
  ok: exitCode === 0,
});

describe("check-standards-platform — parseHadolintJson", () => {
  it("maps hadolint json findings", () => {
    const json = JSON.stringify([
      {
        file: "Dockerfile",
        line: 3,
        column: 1,
        level: "warning",
        code: "DL3008",
        message: "Pin versions in apt-get",
      },
    ]);
    const f = parseHadolintJson(ok(json, 1));
    assert.deepEqual(f, [
      { file: "Dockerfile", line: 3, rule: "DL3008", message: "Pin versions in apt-get" },
    ]);
  });
  it("tolerates non-JSON", () => {
    assert.deepEqual(parseHadolintJson(ok("boom")), []);
  });
});

describe("check-standards-platform — findDockerfiles", () => {
  it("finds Dockerfile, Dockerfile.prod, app.Dockerfile; skips vendor dirs", () => {
    const repo = mkdtempSync(join(tmpdir(), "kit-docker-"));
    try {
      writeFileSync(join(repo, "Dockerfile"), "FROM alpine\n");
      writeFileSync(join(repo, "Dockerfile.prod"), "FROM alpine\n");
      mkdirSync(join(repo, "svc"), { recursive: true });
      writeFileSync(join(repo, "svc", "app.Dockerfile"), "FROM node\n");
      mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
      writeFileSync(join(repo, "node_modules", "pkg", "Dockerfile"), "FROM evil\n");
      const found = findDockerfiles(repo)
        .map((p) => p.slice(repo.length + 1))
        .sort();
      assert.deepEqual(found, ["Dockerfile", "Dockerfile.prod", "svc/app.Dockerfile"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("check-standards-platform — gating", () => {
  it("no Dockerfile → no results (gate doesn't apply)", async () => {
    const scan: PlatformScan = { dockerfiles: [], findings: [], didNotRun: false };
    assert.deepEqual(await checkStandardsPlatform({ scan }), []);
  });

  it("Dockerfile present but hadolint absent → setup gap (warn default, fail enforce)", async () => {
    const scan: PlatformScan = { dockerfiles: ["Dockerfile"], findings: [], didNotRun: true };
    assert.equal((await checkStandardsPlatform({ scan }))[0].status, "warn");
    assert.equal((await checkStandardsPlatform({ scan, enforce: true }))[0].status, "fail");
    assert.equal((await checkStandardsPlatform({ scan }))[0].didNotRun, true);
  });

  it("clean Dockerfile → pass; findings → warn/fail; baseline-frozen → low warn", async () => {
    const clean: PlatformScan = { dockerfiles: ["Dockerfile"], findings: [], didNotRun: false };
    assert.equal((await checkStandardsPlatform({ scan: clean }))[0].status, "pass");

    const dirty: PlatformScan = {
      dockerfiles: ["Dockerfile"],
      findings: [{ file: "Dockerfile", line: 3, rule: "DL3008", message: "pin versions" }],
      didNotRun: false,
    };
    assert.equal((await checkStandardsPlatform({ scan: dirty }))[0].status, "warn");
    assert.equal((await checkStandardsPlatform({ scan: dirty, enforce: true }))[0].status, "fail");

    const frozen = await checkStandardsPlatform({
      scan: dirty,
      enforce: true,
      baseline: [platformKey("hadolint", { file: "Dockerfile", line: 3, rule: "DL3008" })],
    });
    assert.equal(frozen[0].status, "warn");
    assert.equal(frozen[0].severity, "low");
  });
});
