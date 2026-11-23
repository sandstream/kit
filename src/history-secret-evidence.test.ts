import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { checkSecretsInCode, gateStatus } from "./check-security.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const summary = (verified = 0, unverified = 0, chunks = 2) => ({
  level: "info-0",
  msg: "finished scanning",
  chunks,
  bytes: chunks ? 100 : 0,
  verified_secrets: verified,
  unverified_secrets: unverified,
  trufflehog_version: "3.99.7",
});
const finding = (verified: boolean, raw = "synthetic value", detector = "Synthetic") => ({
  DetectorName: detector,
  Verified: verified,
  Raw: raw,
  SourceMetadata: { Data: { Git: { file: "sample.txt", commit: "a".repeat(40) } } },
});

function emit(stream: "stdout" | "stderr", ...records: unknown[]): string {
  return records
    .map((record) => {
      const line = typeof record === "string" ? record : JSON.stringify(record);
      return `printf '%s\\n' '${line.replaceAll("'", "'\\''")}'${stream === "stderr" ? " >&2" : ""}`;
    })
    .join("\n");
}

async function withRepo(
  run: (root: string, tool: (name: string, script: string) => void, git: string) => Promise<void>,
  commitFile = true,
): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "kit-secret-history-"));
  const root = join(scratch, "repo with spaces");
  const bin = join(scratch, "bin");
  const env = {
    PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  };
  try {
    const git = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    mkdirSync(root);
    mkdirSync(bin);
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    const gitInRepo = (...args: string[]) => execFileSync(git, args, { cwd: root });
    gitInRepo("init", "--quiet", "--template=");
    if (commitFile) {
      writeFileSync(join(root, "sample.txt"), "ordinary synthetic text\n");
      gitInRepo("add", "sample.txt");
      gitInRepo(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "fixture",
      );
    }
    process.env.PATH = bin;
    const tool = (name: string, script: string) =>
      writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    tool("mise", "exit 1");
    tool("which", `if [ -x '${bin}/'$1 ]; then printf '%s\\n' '${bin}/'$1; else exit 1; fi`);
    tool("git", `exec '${git}' "$@"`);
    await run(root, tool, git);
  } finally {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmTemp(scratch);
  }
}

const shellFixtures = { skip: process.platform === "win32" };

describe("TruffleHog report evidence", shellFixtures, () => {
  it("requires terminal coverage evidence to pass a scan without findings", async () => {
    await withRepo(async (root, tool) => {
      for (const [script, evidenceStatus] of [
        ["exit 0", "missing"],
        [emit("stdout", "invalid report"), "malformed"],
        [emit("stderr", summary(0, 0, 0)), "partial"],
        [emit("stderr", summary(0, 1)), "partial"],
      ]) {
        tool("trufflehog", script);
        const result = await checkSecretsInCode(root);
        assert.equal(result.status, "warn");
        assert.equal(result.evidenceStatus, evidenceStatus);
        assert.equal(result.scanIncomplete, true);
        assert.equal(gateStatus(result), "fail");
      }
      tool(
        "trufflehog",
        emit(
          "stderr",
          {
            level: "info-2",
            msg: "Error waiting for git command to complete.",
            error: "synthetic diagnostic",
          },
          summary(),
        ),
      );
      const partial = await checkSecretsInCode(root);
      assert.equal(partial.status, "warn");
      assert.equal(partial.evidenceStatus, "partial");
      assert.doesNotMatch(partial.detail, /synthetic diagnostic/);

      tool("trufflehog", emit("stderr", summary()));
      const clean = await checkSecretsInCode(root);
      assert.equal(clean.status, "pass");
      assert.equal(clean.evidenceStatus, "complete-empty");
    });
  });

  it("retains verified findings on process failure and unverified findings on malformed output", async () => {
    await withRepo(async (root, tool) => {
      tool("trufflehog", [emit("stdout", finding(true)), "exit 1"].join("\n"));
      const verified = await checkSecretsInCode(root);
      assert.equal(verified.status, "fail");
      assert.equal(verified.severity, "critical");
      assert.equal(verified.evidenceStatus, "partial");
      assert.equal(verified.hasFindings, true);
      assert.match(verified.detail, /1 VERIFIED-LIVE/);
      assert.doesNotMatch(verified.detail, /synthetic value/);

      tool(
        "trufflehog",
        [
          emit("stdout", finding(false), "invalid report"),
          emit("stderr", summary(0, 1)),
          "exit 183",
        ].join("\n"),
      );
      const unverified = await checkSecretsInCode(root);
      assert.equal(unverified.status, "warn");
      assert.equal(unverified.evidenceStatus, "partial");
      assert.equal(unverified.hasFindings, true);
      assert.match(unverified.detail, /1 unverified/);
    });
  });
});

describe("Secret classification and empty Git history", shellFixtures, () => {
  it("keeps public, example and accepted matches visible without changing their disposition", async () => {
    await withRepo(async (root, tool) => {
      const publicKey = ["ph", "c_", "a".repeat(40)].join("");
      const example = ["postgres", "://", "fixture:pass@localhost/fixture"].join("");
      writeFileSync(join(root, ".kit-secretsignore"), "aaaaaaa:sample.txt:Accepted\n");
      const rows = emit(
        "stdout",
        finding(false, publicKey),
        finding(false, example),
        finding(false, "synthetic value", "Accepted"),
      );
      tool("trufflehog", [rows, emit("stderr", summary(0, 3)), "exit 183"].join("\n"));
      const accepted = await checkSecretsInCode(root);
      assert.equal(accepted.status, "pass");
      assert.equal(accepted.evidenceStatus, "complete");
      assert.match(accepted.detail, /1 public-by-design/);
      assert.match(accepted.detail, /1 example credential/);
      assert.match(accepted.detail, /1 accepted historical finding/);

      tool("trufflehog", [rows, "exit 1"].join("\n"));
      const incomplete = await checkSecretsInCode(root);
      assert.equal(incomplete.status, "warn");
      assert.equal(incomplete.evidenceStatus, "partial");
      assert.match(incomplete.detail, /1 accepted historical finding/);
    });
  });

  it("skips a repository with no committed candidate content", async () => {
    await withRepo(async (root, tool) => {
      tool("trufflehog", "exit 2");
      const result = await checkSecretsInCode(root);
      assert.equal(result.status, "skip");
      assert.equal(result.evidenceStatus, "missing");
      assert.equal(result.didNotRun, undefined);
      assert.match(result.detail, /no committed content/);
      const outside = await checkSecretsInCode(join(root, ".."));
      assert.equal(outside.status, "skip");
      assert.equal(outside.evidenceStatus, "missing");
      assert.equal(outside.didNotRun, undefined);
      assert.match(outside.detail, /not a git repository/);
    }, false);
  });
});

describe("Restricted Git history coverage", shellFixtures, () => {
  it("marks shallow history partial and preserves a finding from a local ref", async () => {
    await withRepo(async (root, tool, git) => {
      const shallow = join(root, "..", "shallow");
      execFileSync(git, ["clone", "--quiet", "--depth=1", pathToFileURL(root).href, shallow], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${process.env.PATH}:/usr/bin:/bin`,
          GIT_ALLOW_PROTOCOL: "file",
        },
      });
      tool("trufflehog", emit("stderr", summary()));
      const empty = await checkSecretsInCode(shallow);
      assert.equal(empty.status, "warn");
      assert.equal(empty.evidenceStatus, "partial");
      assert.match(empty.detail, /shallow clone/);

      const trace = { level: "info-2", msg: "exiting with code 183 because results were found" };
      const checkFlags = 'case " $* " in *" --no-ignore-tag "*) ;; *) exit 2 ;; esac';
      tool(
        "trufflehog",
        [
          checkFlags,
          emit("stdout", finding(true)),
          emit("stderr", summary(1), trace),
          "exit 183",
        ].join("\n"),
      );
      const result = await checkSecretsInCode(shallow);
      assert.equal(result.status, "fail");
      assert.equal(result.evidenceStatus, "partial");
      assert.equal(result.hasFindings, true);
      assert.match(result.detail, /shallow clone/);
    });
  });

  it("distinguishes Git grep matches, no matches, and failure", async () => {
    await withRepo(async (root, tool, git) => {
      const clean = await checkSecretsInCode(root);
      assert.equal(clean.status, "warn");
      assert.equal(clean.evidenceStatus, "partial");
      assert.match(clean.detail, /no matches/);

      const value = ["synthetic", "example", "phrase"].join("_");
      writeFileSync(join(root, "sample.txt"), `password = "${value}"\n`);
      const matches = await checkSecretsInCode(root);
      assert.equal(matches.status, "warn");
      assert.equal(matches.evidenceStatus, "partial");
      assert.deepEqual(matches.files, ["sample.txt"]);

      // Keep native Git for the scope probe and fail only the fallback.
      tool("git", `if [ "$1" = grep ]; then exit 128; fi\nexec '${git}' "$@"`);
      const failed = await checkSecretsInCode(root);
      assert.equal(failed.status, "warn");
      assert.equal(failed.evidenceStatus, "unavailable");
      assert.match(failed.detail, /exit code 128/);
    });
  });
});
