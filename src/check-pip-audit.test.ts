import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it, type TestContext } from "node:test";
import { checkPipAudit } from "./check-pip-audit.js";
import { rmTemp } from "./temp-cleanup.test-support.js";
import { execFileNoThrow, type ExecResult } from "./utils/execFileNoThrow.js";

type Tools = NonNullable<Parameters<typeof checkPipAudit>[1]>;

function fixture(t: TestContext, requirement?: string | Buffer) {
  const root = mkdtempSync(join(tmpdir(), "kit-pip-audit-test-"));
  t.after(() => rmTemp(root));
  const file = join(root, "requirements.txt");
  if (requirement !== undefined) writeFileSync(file, requirement);
  return { root, file };
}

const unexpectedTools: Tools = {
  resolveToolBin: async () => assert.fail("unexpected tool discovery"),
  execFileNoThrow: async () => assert.fail("unexpected scanner process"),
};

function dependency(name: string, version: string, vulns: unknown[] = []) {
  return { name, version, vulns };
}

function advisory(id: string, fix_versions: string[] = []) {
  return { id, fix_versions };
}

function report(dependencies: unknown[], fixes: unknown = []) {
  return { dependencies, fixes };
}

function scanner(stdout: string, exitCode = 0, flags?: Partial<ExecResult>): Tools {
  return {
    resolveToolBin: async () => process.execPath,
    execFileNoThrow: async () => ({ stdout, stderr: "", exitCode, ok: exitCode === 0, ...flags }),
  };
}

it("skips when requirements.txt is absent", async (t) => {
  const { root } = fixture(t);
  const result = await checkPipAudit(root, unexpectedTools);
  assert.equal(result.status, "skip");
  assert.equal(result.didNotRun, undefined);
});

for (const requirement of ["", "\uFEFF# coding: utf-8\r\n  # comment\r\n\t\r\n"]) {
  it(`proves ${requirement ? "a comment-only" : "an empty"} declaration empty without a scanner`, async (t) => {
    const { root } = fixture(t, requirement);
    const result = await checkPipAudit(root, unexpectedTools);
    assert.equal(result.status, "pass");
    assert.equal(result.evidenceStatus, "complete-empty");
    assert.equal(result.didNotRun, undefined);
  });
}

const unsupported = {
  include: "-r local.txt",
  constraint: "--constraint=constraints.txt",
  editable: "-e ./project",
  "index option": "--index-url https://example.invalid/simple",
  "direct URL": "sample @ https://example.invalid/sample.whl",
  "bare URL": "https://example.invalid/sample.whl",
  "local wheel": "./sample-1-py3-none-any.whl",
  "hash option": "sample==1 --hash=sha256:abcd",
  marker: "sample==1; python_version < '3'",
  extra: "sample[test]==1",
  wildcard: "sample==1.*",
  unpinned: "sample",
  "arbitrary equality": "sample===1",
  range: "sample==1,>=1",
  "invalid version": "sample==1.2-foo9",
  "non-ASCII version": "sample==1+\u212a",
  "invalid name": "sample-==1",
  "inline fragment": "sample==1#fragment",
  continuation: "# comment \\\nsample==1",
  "non-UTF-8 encoding declaration": "# coding: latin-1",
  "control character": "# comment\x00",
  "invalid UTF-8": Buffer.from([0xc3, 0x28]),
  "conflicting pins": "Sample_Name==2\nsample-name==1",
};

for (const [label, requirement] of Object.entries(unsupported)) {
  it(`reports unsupported coverage for ${label} before finding a scanner`, async (t) => {
    const { root } = fixture(t, requirement);
    const result = await checkPipAudit(root, unexpectedTools);
    assert.equal(result.status, "warn");
    assert.equal(result.evidenceStatus, "unsupported");
    assert.equal(result.didNotRun, true);
    assert.equal(result.hasFindings, undefined);
  });
}

it("rejects directories and oversized files at the requirements path", async (t) => {
  const directory = fixture(t);
  mkdirSync(directory.file);
  const large = fixture(t, "sample==1\n");
  truncateSync(large.file, 8 * 1024 * 1024 + 1);
  for (const { root } of [directory, large]) {
    const result = await checkPipAudit(root, unexpectedTools);
    assert.equal(result.evidenceStatus, "unavailable");
    assert.equal(result.didNotRun, true);
  }
});

it(
  "rejects a symlink to a regular requirements file",
  { skip: process.platform === "win32" },
  async (t) => {
    const { root, file } = fixture(t);
    const other = fixture(t, "sample==1\n");
    symlinkSync(other.file, file);
    const result = await checkPipAudit(root, unexpectedTools);
    assert.equal(result.evidenceStatus, "unavailable");
    assert.equal(result.didNotRun, true);
  },
);

it("reports unavailable coverage for pins when the scanner is absent", async (t) => {
  const { root } = fixture(t, "sample==1\n");
  const result = await checkPipAudit(root, {
    ...unexpectedTools,
    resolveToolBin: async () => null,
  });
  assert.equal(result.status, "warn");
  assert.equal(result.evidenceStatus, "unavailable");
  assert.equal(result.didNotRun, true);
  assert.equal(result.scanIncomplete, undefined);
  assert.equal(result.severity, undefined);
  assert.match(result.detail, /could not be located/);
});

it("audits a private canonical snapshot and counts advisories from real exit code 1", async (t) => {
  const requirement =
    "# Only these pins should leave the checkout\r\n" +
    "Demo_Name == v02!01.002-Preview_03-r004.Dev+LINUX_0005 \t# local comment\r\n" +
    "demo.name==2!1.2rc3.post4.dev0+linux.5\r\n" +
    "Other==0!02.0-03.dev-02\r\n";
  const { root, file } = fixture(t, requirement);
  const version = "2!1.2rc3.post4.dev0+linux.5";
  const stdout = JSON.stringify(
    report([
      dependency("other", "2.0.post3.dev2"),
      dependency("demo-name", version, [advisory("PYSEC-1", ["2!1.2"]), advisory("CVE-1")]),
    ]),
  );
  let snapshot = "";
  const result = await checkPipAudit(root, {
    resolveToolBin: async (tool) => {
      assert.equal(tool, "pip-audit");
      return process.execPath;
    },
    execFileNoThrow: async (bin, args, options) => {
      snapshot = args[1];
      const dir = dirname(snapshot);
      assert.notEqual(dir, root);
      assert.equal(options?.cwd, dir);
      assert.deepEqual(args, [
        "-r",
        snapshot,
        "--no-deps",
        "--disable-pip",
        "--format=json",
        "--progress-spinner=off",
        "--cache-dir",
        join(dir, "cache"),
      ]);
      if (process.platform !== "win32") {
        assert.equal(statSync(dir).mode & 0o077, 0);
        assert.equal(statSync(snapshot).mode & 0o077, 0);
      }
      assert.equal(
        readFileSync(snapshot, "utf8"),
        `demo-name==${version}\nother==2.0.post3.dev2\n`,
      );
      assert.equal(readFileSync(file, "utf8"), requirement);
      return execFileNoThrow(
        bin,
        ["-e", "process.stdout.write(process.argv[1]); process.exitCode = 1", stdout],
        options,
      );
    },
  });
  assert.equal(result.status, "fail");
  assert.equal(result.evidenceStatus, "complete");
  assert.equal(result.hasFindings, true);
  assert.equal(result.didNotRun, undefined);
  assert.equal(result.severity, undefined);
  assert.deepEqual(result.affected, [{ name: "demo-name", version }]);
  assert.match(result.detail, /2 known vulnerabilities in 1 pinned package/);
  assert.equal(existsSync(dirname(snapshot)), false);
});

it("passes after a successful v2 report covers the full pin inventory with empty vulns", async (t) => {
  const { root } = fixture(t, "Sample_Pkg==01.00RC02\nother==2");
  const json = report([dependency("other", "2"), dependency("sample-pkg", "1.0rc2")]);
  const result = await checkPipAudit(root, scanner(JSON.stringify(json)));
  assert.equal(result.status, "pass");
  assert.equal(result.evidenceStatus, "complete-empty");
  assert.equal(result.didNotRun, undefined);
});

const validRows = [dependency("sample", "1"), dependency("other", "2")];
const incompleteReports = [
  { label: "blank output", stdout: " ", expected: "missing" },
  { label: "truncated JSON", stdout: '{"dependencies":', expected: "malformed" },
  { label: "legacy array", json: validRows, expected: "unsupported" },
  { label: "wrong schema", json: {}, expected: "malformed" },
  { label: "missing fixes", json: { dependencies: validRows }, expected: "malformed" },
  { label: "wrong fixes type", json: report(validRows, {}), expected: "malformed" },
  {
    label: "unexpected fixes",
    json: report(validRows, [{ name: "sample", old_version: "1", new_version: "2" }]),
    expected: "malformed",
  },
  { label: "empty inventory", json: report([]), expected: "missing" },
  { label: "missing pin", json: report([validRows[0]]), expected: "partial" },
  {
    label: "wrong version",
    json: report([validRows[0], dependency("other", "3")]),
    expected: "partial",
  },
  {
    label: "extra package",
    json: report([...validRows, dependency("extra", "1")]),
    expected: "partial",
  },
  { label: "duplicate package", json: report([...validRows, validRows[1]]), expected: "partial" },
  {
    label: "skipped dependency",
    json: report([validRows[0], { name: "other", skip_reason: "not on index" }]),
    expected: "partial",
  },
  {
    label: "unknown finding format",
    json: report([validRows[0], { name: "other", version: "2", vulnerabilities: [] }]),
    expected: "partial",
  },
  { label: "exit 1 with no findings", json: report(validRows), exit: 1, expected: "unavailable" },
];

for (const { label, stdout, json, exit, expected } of incompleteReports) {
  it(`keeps coverage unverified for ${label}`, async (t) => {
    const { root } = fixture(t, "sample==1\nother==2\n");
    const result = await checkPipAudit(root, scanner(stdout ?? JSON.stringify(json), exit));
    assert.equal(result.status, "warn");
    assert.equal(result.evidenceStatus, expected);
    assert.equal(result.didNotRun, true);
    assert.equal(result.scanIncomplete, true);
    assert.equal(result.hasFindings, undefined);
  });
}

it("preserves only validated findings when inventory rows or advisories are invalid", async (t) => {
  const { root } = fixture(t, "sample==1\nother==2\nmissing==1\n");
  const finding = advisory("PYSEC-1");
  const json = report([
    dependency("sample", "1", [finding, null, { id: "broken" }, advisory("invalid-fix", ["1.*"])]),
    dependency("SAMPLE", "1", [finding]),
    dependency("other", "3", [advisory("wrong-version")]),
    { ...dependency("other", "2", [advisory("skipped")]), skip_reason: "unverified" },
    dependency("extra", "1", [advisory("outside-inventory")]),
  ]);
  const result = await checkPipAudit(root, scanner(JSON.stringify(json), 1));
  assert.equal(result.evidenceStatus, "partial");
  assert.equal(result.hasFindings, true);
  assert.equal(result.scanIncomplete, true);
  assert.equal(result.didNotRun, true);
  assert.equal(result.severity, undefined);
  assert.deepEqual(result.affected, [{ name: "sample", version: "1" }]);
  assert.match(result.detail, /^1 known vulnerability in 1 pinned package/);
  assert.match(result.detail, /skipped dependencies/);
});

it("keeps validated findings when fixes or the process exit disagree with the scan", async (t) => {
  const { root } = fixture(t, "sample==1");
  const deps = [dependency("sample", "1", [advisory("PYSEC-1")])];
  const candidates = [
    scanner(JSON.stringify({ dependencies: deps }), 1),
    scanner(JSON.stringify(report(deps)), 0),
    scanner(JSON.stringify(report(deps)), 2),
    scanner(JSON.stringify(report(deps)), 1, { timedOut: true }),
  ];
  for (const tools of candidates) {
    const result = await checkPipAudit(root, tools);
    assert.equal(result.evidenceStatus, "partial");
    assert.equal(result.hasFindings, true);
    assert.equal(result.scanIncomplete, true);
    assert.match(result.detail, /^1 known vulnerability in 1 pinned package/);
  }
});

it("marks the result stale if requirements.txt changes during the scan", async (t) => {
  const { root, file } = fixture(t, "sample==1\n");
  const stdout = JSON.stringify(report([dependency("sample", "1", [advisory("PYSEC-1")])]));
  const result = await checkPipAudit(root, {
    resolveToolBin: async () => process.execPath,
    execFileNoThrow: async (_, [, snapshot]) => {
      writeFileSync(file, "sample==2\n");
      assert.equal(readFileSync(snapshot, "utf8"), "sample==1\n");
      return { ok: false, exitCode: 1, stdout, stderr: "" };
    },
  });
  assert.equal(result.evidenceStatus, "stale");
  assert.equal(result.didNotRun, true);
  assert.equal(result.hasFindings, true);
  assert.deepEqual(result.affected, [{ name: "sample", version: "1" }]);
});

it("removes the snapshot even when scanner execution throws", async (t) => {
  const { root } = fixture(t, "sample==1\n");
  let dir = "";
  const result = await checkPipAudit(root, {
    resolveToolBin: async () => process.execPath,
    execFileNoThrow: async (_, [, snapshot]) => {
      dir = dirname(snapshot);
      throw new Error("fixture execution failed");
    },
  });
  assert.equal(result.evidenceStatus, "unavailable");
  assert.ok(dir);
  assert.equal(existsSync(dir), false);
});
