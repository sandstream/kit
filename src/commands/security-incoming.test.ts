import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { spawnSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { storeFixture } from "../incoming-trust/authority-store.test-support.js";
import { QUARANTINE_ACKNOWLEDGEMENT } from "../incoming-trust/authority-files.js";

const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));
const CHECKS = ["inventory", "artifacts", "scanners"].map((id) => ({
  id,
  status: "pass",
  evidenceDigest: "e".repeat(64),
}));

function runNode(dir: string, args: string[], readOnly = false) {
  const result = spawnSync(process.execPath, args, {
    cwd: dir,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      NO_COLOR: "1",
      KIT_NON_INTERACTIVE: "1",
      KIT_BUMBLEBEE: "0",
      KIT_NO_FAILURE_SIM: "1",
      KIT_NO_UPDATE_CHECK: "1",
      KIT_AUDIT_ANCHOR: "0",
      KIT_HIDE_HOOK_SKIP_BANNER: "1",
      KIT_READ_ONLY: readOnly ? "1" : "0",
    },
  });
  assert.ifError(result.error);
  return {
    status: result.status,
    stdout: result.stdout,
    output: stripVTControlCharacters(result.stdout + result.stderr),
  };
}

type Fixture = ReturnType<typeof storeFixture>;

function incoming(f: Fixture, ...args: string[]) {
  return runNode(f.repository, [
    CLI,
    "security",
    "incoming",
    ...args,
    "--repo",
    f.repository,
    "--store",
    f.directory,
  ]);
}

function json(f: Fixture, ...args: string[]) {
  const result = incoming(f, ...args, "--json");
  assert.equal(result.status, 0, result.output);
  return JSON.parse(result.stdout.trim().split("\n").pop()!);
}

function writeJson(f: Fixture, name: string, value: unknown): string {
  const path = join(f.root, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function dependencyFreeRepository(f: Fixture): void {
  writeFileSync(join(f.repository, "package.json"), '{"name":"x","version":"1.0.0"}');
  writeFileSync(
    join(f.repository, "package-lock.json"),
    '{"name":"x","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"x","version":"1.0.0"}}}',
  );
}

it("drives enroll, stage, request, approve and status through the real CLI", () => {
  const f = storeFixture();
  try {
    dependencyFreeRepository(f);
    assert.deepEqual(json(f, "status"), { enrolled: false });
    const authority = writeJson(f, "authority.json", f.proof.authority);
    assert.equal(json(f, "enroll", "--authority", authority).phase, "pending");
    const snapshot = join(f.root, "snapshot");
    const staged = json(
      f,
      "stage",
      "--source",
      f.repository,
      "--snapshot-dir",
      snapshot,
      "--origin",
      "https://registry.npmjs.org",
    );
    assert.match(staged.candidateDigest, /^[0-9a-f]{64}$/);
    const checks = writeJson(f, "checks.json", [
      ...CHECKS,
      ...(f.store.read(f.repository)?.evidence ?? []),
    ]);
    const out = join(f.root, "verification.json");
    const requested = json(f, "request", "--checks", checks, "--out", out);
    const verification = JSON.parse(readFileSync(out, "utf8"));
    Object.assign(f.proof.verification, verification);
    f.proof.approval.context = { ...verification.context };
    f.proof.approval.issuedAt = verification.createdAt;
    f.proof.approval.expiresAt = verification.createdAt + 20_000;
    f.proof.resign();
    assert.equal(f.proof.approval.verificationDigest, requested.verificationDigest);
    const approval = writeJson(f, "approval.json", f.proof.approval);
    const accepted = json(f, "approve", "--verification", out, "--approval", approval);
    assert.equal(accepted.phase, "accepted");
    assert.equal(json(f, "status").phase, "accepted");
  } finally {
    f.cleanup();
  }
});

it("refuses a forged approval and leaves the state pending", () => {
  const f = storeFixture();
  try {
    dependencyFreeRepository(f);
    json(f, "enroll", "--authority", writeJson(f, "authority.json", f.proof.authority));
    json(
      f,
      "stage",
      "--source",
      f.repository,
      "--snapshot-dir",
      join(f.root, "snapshot"),
      "--origin",
      "https://registry.npmjs.org",
    );
    const out = join(f.root, "verification.json");
    json(
      f,
      "request",
      "--checks",
      writeJson(f, "checks.json", [...CHECKS, ...(f.store.read(f.repository)?.evidence ?? [])]),
      "--out",
      out,
    );
    const verification = JSON.parse(readFileSync(out, "utf8"));
    Object.assign(f.proof.verification, verification);
    f.proof.approval.context = { ...verification.context };
    f.proof.approval.issuedAt = verification.createdAt;
    f.proof.approval.expiresAt = verification.createdAt + 20_000;
    f.proof.resign();
    f.proof.approval.signature = Buffer.alloc(64).toString("base64");
    const result = incoming(
      f,
      "approve",
      "--verification",
      out,
      "--approval",
      writeJson(f, "approval.json", f.proof.approval),
    );
    assert.notEqual(result.status, 0);
    assert.equal(json(f, "status").phase, "pending");
  } finally {
    f.cleanup();
  }
});

it("rejects and retries through the CLI", () => {
  const f = storeFixture();
  try {
    json(f, "enroll", "--authority", writeJson(f, "authority.json", f.proof.authority));
    assert.equal(json(f, "reject").phase, "rejected");
    assert.equal(json(f, "retry").phase, "pending");
  } finally {
    f.cleanup();
  }
});

it("recover needs the acknowledgement and moves only a damaged store", () => {
  const f = storeFixture();
  try {
    json(f, "enroll", "--authority", writeJson(f, "authority.json", f.proof.authority));
    const healthy = incoming(f, "recover", "--acknowledge", QUARANTINE_ACKNOWLEDGEMENT);
    assert.notEqual(healthy.status, 0);
    assert.match(healthy.output, /not-damaged/);
    truncateSync(join(f.directory, "authority.sqlite"), 0);
    const missing = incoming(f, "recover");
    assert.notEqual(missing.status, 0);
    assert.match(missing.output, /--acknowledge/);
    assert.equal(existsSync(join(f.directory, "authority.sqlite")), true);
    const moved = json(f, "recover", "--acknowledge", QUARANTINE_ACKNOWLEDGEMENT);
    assert.match(moved.quarantinedTo, /authority\.sqlite\.damaged-/);
    assert.deepEqual(json(f, "status"), { enrolled: false });
  } finally {
    f.cleanup();
  }
});

it("read-only mode refuses every mutating subcommand", () => {
  const f = storeFixture();
  try {
    mkdirSync(f.directory, { recursive: true });
    const authority = writeJson(f, "authority.json", f.proof.authority);
    const result = runNode(
      f.repository,
      [
        CLI,
        "security",
        "incoming",
        "enroll",
        "--authority",
        authority,
        "--repo",
        f.repository,
        "--store",
        f.directory,
      ],
      true,
    );
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(f.directory, "authority.sqlite")), false);
  } finally {
    f.cleanup();
  }
});

it("prints usage for an unknown subcommand", () => {
  const f = storeFixture();
  try {
    const result = incoming(f, "bogus");
    assert.notEqual(result.status, 0);
    assert.match(result.output, /Usage: kit security incoming|Usage:/);
  } finally {
    f.cleanup();
  }
});

it("refuses a request that claims another digest for a check kit computed at stage", () => {
  const f = storeFixture();
  try {
    dependencyFreeRepository(f);
    json(f, "enroll", "--authority", writeJson(f, "authority.json", f.proof.authority));
    json(
      f,
      "stage",
      "--source",
      f.repository,
      "--snapshot-dir",
      join(f.root, "snapshot"),
      "--origin",
      "https://registry.npmjs.org",
    );
    const kit = f.store.read(f.repository)?.evidence ?? [];
    assert.ok(kit.length > 0, "stage must record kit's own checks");
    const forged = kit.map((check) => ({ ...check, evidenceDigest: "9".repeat(64) }));
    const result = incoming(
      f,
      "request",
      "--checks",
      writeJson(f, "checks.json", [...CHECKS, ...forged]),
    );
    assert.notEqual(result.status, 0);
    assert.match(result.output, /evidence-mismatch/);
  } finally {
    f.cleanup();
  }
});
