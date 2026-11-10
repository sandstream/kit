import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { AnchorRecord } from "./audit-anchor.js";
import { findAnchorRecord, readAnchorStore } from "./audit-anchor-store.js";
import { auditCli, runAuditWorkers, startAuditWorker } from "./audit-concurrency.test-support.js";
import { externalAuditFixture, externalEvidence } from "./audit-external.test-support.js";

type Fixture = Awaited<ReturnType<typeof sealedFixture>>;
const externalModule = JSON.stringify(new URL("./audit-external.js", import.meta.url).href);
let observation = 0;

async function sealedFixture(t: TestContext) {
  const fixture = await externalAuditFixture(t);
  const sealed = auditCli(fixture, ["anchor", "--external"]);
  assert.equal(sealed.status, 0, sealed.stdout + sealed.stderr);
  // Activation itself has an audit event. Verify with read-only mode already active.
  fixture.env.KIT_READ_ONLY = "1";
  const record = (await readAnchorStore(fixture.indexPath))[fixture.logPath];
  assert.ok(record.external?.statement);
  return { ...fixture, record, observedPaths: [] as string[] };
}

function evidence(fixture: Fixture) {
  const original = externalEvidence(fixture);
  const files = {
    ...original,
    publicKey: readFileSync(join(fixture.witness, "public.pem")),
    ...Object.fromEntries(fixture.observedPaths.map((path) => [path, readFileSync(path)])),
  };
  return Object.fromEntries(
    Object.entries(files).map(([name, bytes]) => [
      name,
      bytes === null
        ? null
        : {
            sha256: createHash("sha256").update(bytes).digest("hex"),
            base64: bytes.toString("base64"),
          },
    ]),
  );
}

// Opt-in private receipts retain synthetic evidence before fixture teardown, including failures.
function retainObservation(value: unknown) {
  const directory = process.env.KIT_AUDIT_ALIAS_EVIDENCE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `observation-${process.pid}-${++observation}.json`),
    JSON.stringify(value, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
}

function checkCli(fixture: Fixture, flags: string[], expected: number, project = fixture.project) {
  const before = evidence(fixture);
  const args = ["verify", "--require-external", "--strict", ...flags];
  const result = auditCli({ ...fixture, project }, args);
  const after = evidence(fixture);
  retainObservation({
    operation: "CLI",
    project,
    args,
    expected,
    actual: {
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    },
    before,
    after,
  });
  assert.deepEqual(after, before, "Verification must preserve all evidence");
  assert.equal(result.status, expected, result.stdout + result.stderr);
  if (flags.includes("--all")) {
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, expected === 0);
    if (expected === 0) {
      assert.ok(report.results.length > 0);
      for (const row of report.results) {
        assert.equal(row.outcome, "verified");
        assert.equal(row.externalVerification.status, "verified");
        assert.equal(row.externalVerification.authenticity, "valid");
        assert.equal(row.externalVerification.rollback, "acceptable");
      }
    }
  } else if (expected === 0) {
    assert.match(result.stdout, /verified external anchor/);
  }
  return result;
}

async function checkApi(fixture: Fixture, path: string, expected: "verified" | "invalid") {
  const before = evidence(fixture);
  const worker = startAuditWorker(
    fixture,
    `
    const { verifyExternalAnchor } = await import(${externalModule});
    const path = ${JSON.stringify(path)};
    const record = await anchor.readAnchorRecord(path);
    assert.ok(record);
    const local = anchor.verifyAgainstAnchor(await readFile(path, "utf8"), record, await anchor.tryReadAuditAnchorKey());
    assert.equal(local.status, "anchored-ok");
    const result = await verifyExternalAnchor(path, record);
    signal(JSON.stringify(result));
  `,
  );
  await runAuditWorkers([worker]);
  const actual = JSON.parse(worker.messages.find((message) => message.startsWith("{"))!);
  const after = evidence(fixture);
  retainObservation({ operation: "API", path, expected, actual, before, after });
  assert.deepEqual(after, before);
  assert.equal(actual.status, expected, actual.message);
  if (expected === "verified") {
    assert.equal(actual.authenticity, "valid");
    assert.equal(actual.rollback, "acceptable");
  } else {
    assert.match(actual.message, /statement does not match this log and seal/);
  }
}

function directoryAlias(fixture: Fixture) {
  const project = join(fixture.root, "directory-alias");
  symlinkSync(fixture.project, project, process.platform === "win32" ? "junction" : "dir");
  return { project, logPath: join(project, ".kit-audit.jsonl") };
}

test("a genuine external receipt survives directory aliases and an alias-only index", async (t) => {
  const fixture = await sealedFixture(t);
  const alias = directoryAlias(fixture);
  writeFileSync(fixture.indexPath, JSON.stringify({ [alias.logPath]: fixture.record }));
  for (const path of [fixture.logPath, alias.logPath]) await checkApi(fixture, path, "verified");
  for (const project of [fixture.project, alias.project, fixture.project]) {
    checkCli(fixture, [], 0, project);
  }
  checkCli(fixture, ["--all", "--json"], 0);
});

test("a genuine external receipt survives a file symlink without changing signed bytes", async (t) => {
  const fixture = await sealedFixture(t);
  const project = join(fixture.root, "file-alias");
  mkdirSync(project);
  const path = join(project, ".kit-audit.jsonl");
  try {
    symlinkSync(fixture.logPath, path, "file");
  } catch (error) {
    if (
      process.platform !== "win32" ||
      !["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")
    )
      throw error;
    const reason =
      "expected: Windows denied file symlinks; Developer Mode or symlink permission is required. Directory and copy controls remain active.";
    t.diagnostic(reason);
    retainObservation({ operation: "capability", expected: "file symlink unavailable", reason });
    // Keep a genuine positive control even when this platform denies file symlinks.
    checkCli(fixture, [], 0);
    t.skip(reason);
    return;
  }
  fixture.observedPaths.push(path);
  writeFileSync(fixture.indexPath, JSON.stringify({ [path]: fixture.record }));
  await checkApi(fixture, path, "verified");
  checkCli(fixture, [], 0, project);
  checkCli(fixture, ["--all", "--json"], 0);
});

test("case aliases retain external receipts only when they identify the same file", async (t) => {
  const fixture = await sealedFixture(t);
  const alias = join(fixture.project, ".KIT-AUDIT.JSONL");
  const supported = existsSync(alias);
  if (supported) {
    const original = statSync(fixture.logPath, { bigint: true });
    const candidate = statSync(alias, { bigint: true });
    assert.notEqual(original.ino, 0n);
    assert.equal(candidate.ino, original.ino);
    assert.equal(candidate.dev, original.dev);
    t.diagnostic(
      "expected: this filesystem resolves both case spellings to the same file; signed verification must succeed.",
    );
  } else {
    t.diagnostic(
      "expected: this filesystem distinguishes case spellings; same-file case aliases are unavailable. A copied case variant must refuse.",
    );
    copyFileSync(fixture.logPath, alias);
  }
  retainObservation({
    operation: "capability",
    expected: supported ? "same-file case alias verifies" : "different case file refuses",
    reason: supported
      ? "Both spellings have the same device and nonzero inode."
      : "The alternate case spelling does not exist on this filesystem.",
  });
  fixture.observedPaths.push(alias);
  writeFileSync(fixture.indexPath, JSON.stringify({ [alias]: fixture.record }));
  await checkApi(fixture, alias, supported ? "verified" : "invalid");
  checkCli(fixture, ["--all", "--json"], supported ? 0 : 1);
  if (supported) checkCli(fixture, [], 0);
});

test("a byte-identical different file cannot reuse a genuine external receipt", async (t) => {
  const fixture = await sealedFixture(t);
  const project = join(fixture.root, "copied-project");
  mkdirSync(project);
  const copy = join(project, ".kit-audit.jsonl");
  copyFileSync(fixture.logPath, copy);
  assert.deepEqual(readFileSync(copy), readFileSync(fixture.logPath));
  const originalIdentity = statSync(fixture.logPath, { bigint: true });
  const copyIdentity = statSync(copy, { bigint: true });
  assert.ok(originalIdentity.dev !== copyIdentity.dev || originalIdentity.ino !== copyIdentity.ino);
  fixture.observedPaths.push(copy);
  writeFileSync(
    fixture.indexPath,
    JSON.stringify({ [fixture.logPath]: fixture.record, [copy]: fixture.record }),
  );
  await checkApi(fixture, fixture.logPath, "verified");
  await checkApi(fixture, copy, "invalid");
  const single = checkCli(fixture, [], 1, project);
  assert.match(single.stdout + single.stderr, /statement does not match this log and seal/);
  checkCli(fixture, ["--all", "--json"], 1);
  checkCli(fixture, [], 0);
});

test("equivalent alias statements remain valid regardless of field and index order", async (t) => {
  const fixture = await sealedFixture(t);
  const alias = directoryAlias(fixture);
  const reordered = structuredClone(fixture.record);
  const statement = reordered.external!.statement!;
  reordered.external!.statement = Object.fromEntries(
    Object.entries(statement).reverse(),
  ) as typeof statement;
  for (const entries of [
    [
      [fixture.logPath, fixture.record],
      [alias.logPath, reordered],
    ],
    [
      [alias.logPath, reordered],
      [fixture.logPath, fixture.record],
    ],
  ] as [string, AnchorRecord][][]) {
    writeFileSync(fixture.indexPath, JSON.stringify(Object.fromEntries(entries)));
    await checkApi(fixture, alias.logPath, "verified");
    checkCli(fixture, [], 0);
    checkCli(fixture, ["--all", "--json"], 0);
  }
});

test("conflicting alias statement records refuse in either index order and preserve evidence", async (t) => {
  const fixture = await sealedFixture(t);
  const alias = directoryAlias(fixture);
  const conflicting = structuredClone(fixture.record);
  conflicting.external!.statement!.count += 1;
  for (const entries of [
    [
      [fixture.logPath, fixture.record],
      [alias.logPath, conflicting],
    ],
    [
      [alias.logPath, conflicting],
      [fixture.logPath, fixture.record],
    ],
  ] as [string, AnchorRecord][][]) {
    writeFileSync(fixture.indexPath, JSON.stringify(Object.fromEntries(entries)));
    const before = evidence(fixture);
    const store = await readAnchorStore(fixture.indexPath);
    for (const path of [fixture.logPath, alias.logPath]) {
      assert.throws(() => findAnchorRecord(store, path), /Conflicting audit anchors/);
    }
    assert.deepEqual(evidence(fixture), before);
    for (const project of [fixture.project, alias.project]) {
      const result = checkCli(fixture, [], 1, project);
      assert.match(result.stdout + result.stderr, /Conflicting audit anchors/);
    }
    checkCli(fixture, ["--all", "--json"], 1);
  }
});

for (const aliasFirst of [false, true]) {
  test(`individually authentic but conflicting alias statements refuse union approval (${aliasFirst ? "alias first" : "canonical first"})`, async (t) => {
    const fixture = await sealedFixture(t);
    const alias = directoryAlias(fixture);
    const recordPath = join(fixture.root, "signed-alias-record.json");
    // Obtain a second genuine signature through the public issuer API, with the alias spelling.
    await runAuditWorkers([
      startAuditWorker(
        fixture,
        `
    const { externalStatement, resolveExternalAnchor, verifyExternalAnchor } = await import(${externalModule});
    const path = ${JSON.stringify(alias.logPath)};
    const record = await anchor.readAnchorRecord(path);
    const statement = externalStatement(path, record);
    const issued = await resolveExternalAnchor().anchor({ logPath: path, tip: record.tip, count: record.count, statement });
    record.external = { ...issued, statement };
    const verified = await verifyExternalAnchor(path, record);
    assert.equal(verified.status, "verified", verified.message);
    await writeFile(${JSON.stringify(recordPath)}, JSON.stringify(record));
  `,
      ),
    ]);
    const conflicting: AnchorRecord = JSON.parse(readFileSync(recordPath, "utf8"));
    // Each receipt has its own real signature and current witness checkpoint.
    for (const [path, record] of [
      [fixture.logPath, fixture.record],
      [alias.logPath, conflicting],
    ] as const) {
      writeFileSync(fixture.indexPath, JSON.stringify({ [path]: record }));
      await checkApi(fixture, path, "verified");
      checkCli(fixture, ["--all", "--json"], 0);
    }
    const entries: [string, AnchorRecord][] = [
      [fixture.logPath, fixture.record],
      [alias.logPath, conflicting],
    ];
    if (aliasFirst) entries.reverse();
    writeFileSync(fixture.indexPath, JSON.stringify(Object.fromEntries(entries)));
    const single = checkCli(fixture, [], 1);
    assert.match(single.stdout + single.stderr, /Conflicting audit anchors/);
    checkCli(fixture, ["--all", "--json"], 1);
  });
}
