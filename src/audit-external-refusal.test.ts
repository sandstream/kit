import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { auditCli } from "./audit-concurrency.test-support.js";
import { externalAuditFixture, externalEvidence } from "./audit-external.test-support.js";

function command(root: string, name: string, body: string) {
  const path = join(root, `${name}.mjs`);
  writeFileSync(path, body);
  return `"${process.execPath}" "${path}"`;
}

test("external issuance refuses missing configuration before running an issuer", async (t) => {
  const fixture = await externalAuditFixture(t);
  const marker = join(fixture.witness, "issuer-ran");
  fixture.env.KIT_EXTERNAL_ANCHOR_CMD = command(
    fixture.witness,
    "issuer-trap",
    `
    import {writeFileSync} from 'node:fs';
    writeFileSync(${JSON.stringify(marker)},'ran');
    process.stdout.write(JSON.stringify({token:'forged',authority:'test',timestamp:'now'}));
  `,
  );
  delete fixture.env.KIT_EXTERNAL_ANCHOR_VERIFY_CMD;
  const before = externalEvidence(fixture);
  const checked = auditCli(fixture, ["anchor", "--external"]);
  assert.equal(checked.status, 1, checked.stdout + checked.stderr);
  assert.match(checked.stdout + checked.stderr, /verification is not configured/i);
  assert.equal(existsSync(marker), false);
  assert.deepEqual(externalEvidence(fixture), before);
});

test("failed external issuance preserves the previously published local evidence", async (t) => {
  const fixture = await externalAuditFixture(t);
  const sealed = auditCli(fixture, ["anchor", "--external"]);
  assert.equal(sealed.status, 0, sealed.stdout + sealed.stderr);
  const before = externalEvidence(fixture);
  const originalIssuer = fixture.env.KIT_EXTERNAL_ANCHOR_CMD;
  const originalVerifier = fixture.env.KIT_EXTERNAL_ANCHOR_VERIFY_CMD;
  for (const kind of [
    "issuer-failure",
    "issuer-malformed",
    "verifier-failure",
    "verifier-unknown",
  ]) {
    fixture.env.KIT_EXTERNAL_ANCHOR_CMD = originalIssuer;
    fixture.env.KIT_EXTERNAL_ANCHOR_VERIFY_CMD = originalVerifier;
    const variable = kind.startsWith("issuer")
      ? "KIT_EXTERNAL_ANCHOR_CMD"
      : "KIT_EXTERNAL_ANCHOR_VERIFY_CMD";
    fixture.env[variable] = command(
      fixture.witness,
      kind,
      kind.endsWith("failure")
        ? "process.stderr.write('provider-private-diagnostic'); process.exit(7);"
        : kind.endsWith("malformed")
          ? "process.stdout.write('not-json');"
          : `import {readFileSync} from 'node:fs'; const r=JSON.parse(readFileSync(0,'utf8'));
           process.stdout.write(JSON.stringify({...r,authenticity:'unknown',rollback:'unknown'}));`,
    );
    const checked = auditCli(fixture, ["anchor", "--external"]);
    assert.equal(checked.status, 1, kind + checked.stdout + checked.stderr);
    assert.doesNotMatch(checked.stdout + checked.stderr, /provider-private-diagnostic/);
    assert.deepEqual(externalEvidence(fixture), before, kind);
  }
});

test("required verification refuses malformed, mismatched and unknown responses without issuance", async (t) => {
  const fixture = await externalAuditFixture(t);
  const sealed = auditCli(fixture, ["anchor", "--external"]);
  assert.equal(sealed.status, 0, sealed.stdout + sealed.stderr);
  fixture.env.KIT_READ_ONLY = "1";
  const marker = join(fixture.witness, "unexpected-issuer");
  fixture.env.KIT_EXTERNAL_ANCHOR_CMD = command(
    fixture.witness,
    "unexpected-issuer",
    `
    import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'ran'); process.exit(8);
  `,
  );
  const changes = [
    "process.stdout.write('not-json');",
    "process.stdout.write('null');",
    "out.version=2;",
    "out.requestId='previous-request';",
    "out.statementDigest='wrong-statement';",
    "out.receiptDigest='wrong-receipt';",
    "delete out.authenticity;",
    "out.authenticity='unknown';",
    "out.rollback='unknown';",
    "delete out.rollback;",
    "out.authority='different-authority';",
    "out.attestedAt='different-time';",
    "process.stderr.write('provider-private-diagnostic');process.exit(9);",
  ];
  const before = externalEvidence(fixture);
  for (const [i, change] of changes.entries()) {
    fixture.env.KIT_EXTERNAL_ANCHOR_VERIFY_CMD = command(
      fixture.witness,
      `response-${i}`,
      `
      import {readFileSync} from 'node:fs';
      const r=JSON.parse(readFileSync(0,'utf8'));
      const out={version:1,requestId:r.requestId,statementDigest:r.statementDigest,receiptDigest:r.receiptDigest,
        authenticity:'valid',rollback:'acceptable',authority:r.receipt.authority,attestedAt:r.receipt.timestamp};
      ${change}
      ${change.startsWith("process.") ? "" : "process.stdout.write(JSON.stringify(out));"}
    `,
    );
    for (const flags of [[], ["--all", "--json"]]) {
      const checked = auditCli(fixture, ["verify", "--require-external", ...flags]);
      assert.equal(checked.status, 1, change + checked.stdout + checked.stderr);
      assert.match(checked.stdout + checked.stderr, /external.*(?:UNVERIFIED|INVALID)/i);
      assert.doesNotMatch(checked.stdout + checked.stderr, /provider-private-diagnostic/);
      assert.equal(existsSync(marker), false);
      assert.deepEqual(externalEvidence(fixture), before, change);
    }
  }
});

test("optional external verification warns when unavailable and fails a known invalid receipt", async (t) => {
  const fixture = await externalAuditFixture(t);
  const sealed = auditCli(fixture, ["anchor", "--external"]);
  assert.equal(sealed.status, 0, sealed.stdout + sealed.stderr);
  fixture.env.KIT_READ_ONLY = "1";
  const verifier = fixture.env.KIT_EXTERNAL_ANCHOR_VERIFY_CMD;
  delete fixture.env.KIT_EXTERNAL_ANCHOR_VERIFY_CMD;
  const unavailableBefore = externalEvidence(fixture);
  for (const flags of [[], ["--all", "--json"]]) {
    const checked = auditCli(fixture, ["verify", ...flags]);
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    assert.match(checked.stdout + checked.stderr, /unverified/i);
    assert.deepEqual(externalEvidence(fixture), unavailableBefore);
  }
  fixture.env.KIT_EXTERNAL_ANCHOR_VERIFY_CMD = verifier;
  const index = JSON.parse(readFileSync(fixture.indexPath, "utf8"));
  // Expected failure: the real verifier authenticates the original authority label.
  index[fixture.logPath].external.authority = "forged-label";
  writeFileSync(fixture.indexPath, JSON.stringify(index));
  const invalidBefore = externalEvidence(fixture);
  for (const flags of [[], ["--all", "--json"]]) {
    const checked = auditCli(fixture, ["verify", ...flags]);
    assert.equal(checked.status, 1, checked.stdout + checked.stderr);
    assert.match(checked.stdout + checked.stderr, /external.*INVALID/i);
    assert.deepEqual(externalEvidence(fixture), invalidBefore);
  }
});

test("a genuine signature with an unknown current checkpoint cannot satisfy the requirement", async (t) => {
  const fixture = await externalAuditFixture(t);
  const sealed = auditCli(fixture, ["anchor", "--external"]);
  assert.equal(sealed.status, 0, sealed.stdout + sealed.stderr);
  fixture.env.KIT_READ_ONLY = "1";
  unlinkSync(join(fixture.witness, "heads.json"));
  const before = externalEvidence(fixture);
  for (const flags of [[], ["--all", "--json"]]) {
    const checked = auditCli(fixture, ["verify", "--require-external", ...flags]);
    assert.equal(checked.status, 1, checked.stdout + checked.stderr);
    assert.match(checked.stdout + checked.stderr, /trusted checkpoint is unknown/i);
    assert.deepEqual(externalEvidence(fixture), before);
  }
});

test("legacy and malformed statement metadata cannot satisfy required verification", async (t) => {
  const fixture = await externalAuditFixture(t);
  const sealed = auditCli(fixture, ["anchor", "--external"]);
  assert.equal(sealed.status, 0, sealed.stdout + sealed.stderr);
  fixture.env.KIT_READ_ONLY = "1";
  const original = readFileSync(fixture.indexPath, "utf8");
  const variants = [
    undefined,
    { version: 2 },
    { domain: "another-domain" },
    { algorithm: "none" },
    { count: -1 },
    { tip: "invalid" },
  ];
  for (const fields of variants) {
    const index = JSON.parse(original);
    if (fields) Object.assign(index[fixture.logPath].external.statement, fields);
    else delete index[fixture.logPath].external.statement;
    writeFileSync(fixture.indexPath, JSON.stringify(index));
    const before = externalEvidence(fixture);
    for (const flags of [[], ["--all", "--json"]]) {
      const checked = auditCli(fixture, ["verify", "--require-external", ...flags]);
      assert.equal(checked.status, 1, checked.stdout + checked.stderr);
      assert.deepEqual(externalEvidence(fixture), before);
    }
  }
});
