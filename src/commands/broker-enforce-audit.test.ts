import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { chainedAuditLog, observeEvent } from "../audit-chain.test-support.js";
import { createCliContractFixture } from "../cli-contract.test-support.js";
import { PROFILE_FILE } from "../profile/schema.js";
import { PROFILE_SIG_FILE } from "../profile/sign.js";

const scope = 'version = 1\n[scope]\nfs = ["src"]\n';

function readEvents(path: string) {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function installCommandSigner(
  fixture: ReturnType<typeof createCliContractFixture>,
  beforeSigning = "",
): void {
  const signer = join(fixture.cwd, "signer.mjs");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const key = privateKey.export({ type: "pkcs8", format: "pem" });
  writeFileSync(
    signer,
    `import { sign } from "node:crypto";
import { mkdirSync, readFileSync, renameSync } from "node:fs";
const input = readFileSync(0);
${beforeSigning}
process.stdout.write(sign(null, input, ${JSON.stringify(key)}).toString("base64"));
`,
  );
  fixture.env.KIT_KEYSTORE = "command";
  fixture.env.KIT_KEYSTORE_PUBKEY = publicKey.export({ type: "spki", format: "pem" }).toString();
  fixture.env.KIT_KEYSTORE_SIGN_CMD = `"${process.execPath}" "${signer}"`;
}

test("broker enforce --force leaves the signed profile intact if the audit log cannot accept a record", (t) => {
  const fixture = createCliContractFixture(
    '[governance.audit]\nenabled = true\nlog_file = "audit-out"\n',
  );
  t.after(fixture.cleanup);
  const profilePath = join(fixture.cwd, PROFILE_FILE);
  const sigPath = join(fixture.cwd, PROFILE_SIG_FILE);
  const sink = join(fixture.cwd, "audit-out");
  mkdirSync(sink);
  writeFileSync(join(sink, "keep"), "fixture evidence");
  writeFileSync(profilePath, scope);
  const identity = fixture.run(["identity", "init"]);
  assert.equal(identity.status, 0, identity.stdout + identity.stderr);
  const sign = fixture.run(["profile", "sign"]);
  assert.equal(sign.status, 0, sign.stdout + sign.stderr);
  const profile = readFileSync(profilePath);
  const signature = readFileSync(sigPath);

  const result = fixture.run(["broker", "enforce", "--force", "--json"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(readFileSync(profilePath), profile);
  assert.deepEqual(readFileSync(sigPath), signature);
  assert.equal(readFileSync(join(sink, "keep"), "utf8"), "fixture evidence");
  const report = JSON.parse(result.stdout);
  assert.equal(report.enforced, false);
  assert.match(report.reason, /audit log/i);
});

test("broker enforce preserves the profile when the requested scope cannot be signed", (t) => {
  const fixture = createCliContractFixture();
  t.after(fixture.cleanup);
  const profilePath = join(fixture.cwd, PROFILE_FILE);
  writeFileSync(profilePath, scope);

  const result = fixture.run(["broker", "enforce", "--force", "--json"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(readFileSync(profilePath, "utf8"), scope);
  assert.equal(existsSync(join(fixture.cwd, PROFILE_SIG_FILE)), false);
  const report = JSON.parse(result.stdout);
  assert.equal(report.enforced, false);
  assert.match(report.reason, /sign/);

  const events = readEvents(join(fixture.cwd, ".kit-audit.jsonl"));
  assert.deepEqual(
    events.map((event) => [event.operation, event.metadata.phase, event.success]),
    [
      ["broker.enforce", "enforce-requested", true],
      ["broker.enforce", "enforce-failed", false],
    ],
  );
  assert.ok(events[0].metadata.transitionId);
  assert.equal(events[1].metadata.transitionId, events[0].metadata.transitionId);
});

test("broker enforce preserves the profile when the signature cannot be published", (t) => {
  const fixture = createCliContractFixture();
  t.after(fixture.cleanup);
  const profilePath = join(fixture.cwd, PROFILE_FILE);
  const signaturePath = join(fixture.cwd, PROFILE_SIG_FILE);
  writeFileSync(profilePath, scope);
  mkdirSync(signaturePath);
  writeFileSync(join(signaturePath, "keep"), "fixture evidence");
  const identity = fixture.run(["identity", "init"]);
  assert.equal(identity.status, 0, identity.stdout + identity.stderr);

  const result = fixture.run(["broker", "enforce", "--force", "--json"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).enforced, false);
  assert.equal(readFileSync(profilePath, "utf8"), scope);
  assert.equal(readFileSync(join(signaturePath, "keep"), "utf8"), "fixture evidence");
});

test("broker enforce preserves the profile when the staged signature lacks trusted verification", (t) => {
  const fixture = createCliContractFixture();
  t.after(fixture.cleanup);
  const profilePath = join(fixture.cwd, PROFILE_FILE);
  writeFileSync(profilePath, scope);
  fixture.env.KIT_IDENTITY_DIR = join(fixture.root, "unavailable-identity");
  writeFileSync(fixture.env.KIT_IDENTITY_DIR, "fixture without writable identity storage");
  installCommandSigner(fixture);

  const result = fixture.run(["broker", "enforce", "--force", "--json"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.enforced, false);
  assert.match(report.reason, /signer .*unknown/i);
  assert.equal(readFileSync(profilePath, "utf8"), scope);
  assert.equal(existsSync(join(fixture.cwd, PROFILE_SIG_FILE)), false);
});

test("broker enforce records the request and the verified completion under one transition ID", (t) => {
  const fixture = createCliContractFixture();
  t.after(fixture.cleanup);
  fixture.env.KIT_AUDIT_ANCHOR = "1";
  writeFileSync(join(fixture.cwd, PROFILE_FILE), scope);
  const identity = fixture.run(["identity", "init"]);
  assert.equal(identity.status, 0, identity.stdout + identity.stderr);

  const result = fixture.run(["broker", "enforce", "--force", "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.enforced, true);
  assert.equal(report.audit, "recorded");
  const profile = fixture.run(["profile", "verify", "--json"]);
  assert.equal(profile.status, 0, profile.stdout + profile.stderr);
  assert.equal(JSON.parse(profile.stdout).status, "valid");

  const events = readEvents(join(fixture.cwd, ".kit-audit.jsonl"));
  assert.deepEqual(
    events.map((event) => [event.operation, event.metadata.phase, event.metadata.forced]),
    [
      ["broker.enforce", "enforce-requested", true],
      ["broker.enforce", "enforce-enabled", true],
    ],
  );
  assert.ok(events[0].metadata.transitionId);
  assert.equal(events[1].metadata.transitionId, events[0].metadata.transitionId);
  assert.equal(JSON.parse(profile.stdout).enforcementRequestId, events[0].metadata.transitionId);
  assert.equal(events[1].metadata.fingerprint, report.fingerprint);
  assert.match(events[0].metadata.profileDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(events[1].metadata.profileDigest, events[0].metadata.profileDigest);

  const resign = fixture.run(["profile", "sign"]);
  assert.equal(resign.status, 0, resign.stdout + resign.stderr);
  const retry = fixture.run(["broker", "enforce", "--json"]);
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  assert.equal(JSON.parse(retry.stdout).alreadyEnforcing, true);
  assert.deepEqual(readEvents(join(fixture.cwd, ".kit-audit.jsonl")), events);

  const signaturePath = join(fixture.cwd, PROFILE_SIG_FILE);
  const legacySignature = JSON.parse(readFileSync(signaturePath, "utf8"));
  delete legacySignature.enforcement;
  writeFileSync(signaturePath, JSON.stringify(legacySignature));
  const withoutBinding = fixture.run(["broker", "enforce", "--json"]);
  assert.equal(withoutBinding.status, 1, withoutBinding.stdout + withoutBinding.stderr);
  assert.equal(JSON.parse(withoutBinding.stdout).audit, "incomplete");
  assert.deepEqual(readEvents(join(fixture.cwd, ".kit-audit.jsonl")), events);
});

test("broker enforce preserves the unsealed observe log when it is also the audit destination", (t) => {
  const fixture = createCliContractFixture();
  t.after(fixture.cleanup);
  const path = join(fixture.cwd, ".kit-audit.jsonl");
  const first = chainedAuditLog([observeEvent([])]);
  const withTail = chainedAuditLog([observeEvent([]), observeEvent([])]);
  writeFileSync(path, first);
  const seal = fixture.run(["audit", "anchor"]);
  assert.equal(seal.status, 0, seal.stdout + seal.stderr);
  writeFileSync(path, withTail);
  const profilePath = join(fixture.cwd, PROFILE_FILE);
  writeFileSync(profilePath, scope);

  const result = fixture.run(["broker", "enforce", "--force", "--json"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.enforced, false);
  assert.match(report.reason, /unverifiable observe evidence/);
  assert.equal(readFileSync(path, "utf8"), withTail);
  assert.equal(readFileSync(profilePath, "utf8"), scope);
});

test("broker enforce does not report an unsigned enforcement request as already enforcing", (t) => {
  const fixture = createCliContractFixture();
  t.after(fixture.cleanup);
  const profilePath = join(fixture.cwd, PROFILE_FILE);
  const requestedScope = scope + "enforce_runtime = true\n";
  writeFileSync(profilePath, requestedScope);

  const result = fixture.run(["broker", "enforce", "--force", "--json"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.enforced, false);
  assert.notEqual(report.alreadyEnforcing, true);
  assert.match(report.reason, /signature/i);
  assert.equal(readFileSync(profilePath, "utf8"), requestedScope);
});

test("broker enforce reports when the project explicitly disables audit logging", (t) => {
  const fixture = createCliContractFixture("[governance.audit]\nenabled = false\n");
  t.after(fixture.cleanup);
  writeFileSync(join(fixture.cwd, PROFILE_FILE), scope);
  const identity = fixture.run(["identity", "init"]);
  assert.equal(identity.status, 0, identity.stdout + identity.stderr);

  const result = fixture.run(["broker", "enforce", "--force", "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.enforced, true);
  assert.equal(report.audit, "disabled");
  assert.equal(existsSync(join(fixture.cwd, ".kit-audit.jsonl")), false);
});

test("broker enforce reports an incomplete audit if the completion write fails", (t) => {
  const fixture = createCliContractFixture(
    '[governance.audit]\nenabled = true\nlog_file = "transition-audit.jsonl"\n',
  );
  t.after(fixture.cleanup);
  fixture.env.KIT_AUDIT_ANCHOR = "1";
  writeFileSync(join(fixture.cwd, PROFILE_FILE), scope);
  const auditFile = join(fixture.cwd, "transition-audit.jsonl");
  const requested = join(fixture.cwd, "recorded-request.jsonl");
  // The fixture loses its write destination during the profile-sign operation.
  installCommandSigner(
    fixture,
    `if (input.toString().includes('"enforce_runtime":true')) {
  renameSync(${JSON.stringify(auditFile)}, ${JSON.stringify(requested)});
  mkdirSync(${JSON.stringify(auditFile)});
}`,
  );

  const result = fixture.run(["broker", "enforce", "--force", "--json"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.enforced, true);
  assert.equal(report.audit, "incomplete");
  assert.match(report.reason, /completed transition/i);
  assert.deepEqual(
    readEvents(requested).map((event) => event.metadata.phase),
    ["enforce-requested"],
  );
  const verified = fixture.run(["profile", "verify", "--json"]);
  assert.equal(verified.status, 0, verified.stdout + verified.stderr);
  assert.equal(JSON.parse(verified.stdout).status, "valid");
  const retry = fixture.run(["broker", "enforce", "--json"]);
  assert.equal(retry.status, 1, retry.stdout + retry.stderr);
  assert.equal(JSON.parse(retry.stdout).audit, "incomplete");

  rmdirSync(auditFile);
  renameSync(requested, auditFile);
  const recovery = fixture.run(["broker", "enforce", "--json"]);
  assert.equal(recovery.status, 0, recovery.stdout + recovery.stderr);
  assert.equal(JSON.parse(recovery.stdout).audit, "recorded");
  const recovered = readEvents(auditFile);
  assert.equal(recovered[1].metadata.phase, "enforce-enabled");
  assert.equal(recovered[1].metadata.recovered, true);
  assert.equal(recovered[1].metadata.transitionId, recovered[0].metadata.transitionId);
});
