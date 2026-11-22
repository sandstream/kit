import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { runCli } from "./cli-run.test-support.js";
import {
  EMPTY_SARIF,
  makeFixture,
  scan,
  toml,
  tool,
  type Fixture,
} from "./commands/scan.test-support.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const skip = process.platform === "win32" ? "fake tools are POSIX shell scripts" : false;
const env = { KIT_EXPLOIT_INTEL: "0", KIT_READ_ONLY: "0" };
const grype = '[scan]\ndelegates = ["grype"]\n';
const baseline =
  '{"version":1,"generated":"2026-01-01T00:00:00.000Z","categories":{"scan":{"findings":["prior"]}}}\n';

function successfulScanner(f: Fixture, name = "grype"): void {
  tool(f, name, `printf '%s\\n' '${EMPTY_SARIF}'`);
}

const gaps = [
  {
    label: "missing declared project",
    config: '\n[projects]\npaths = ["missing"]\n',
    kind: "project",
    evidenceStatus: "missing",
  },
  {
    label: "invalid configured image",
    config: 'images = ["invalid ref"]\n',
    kind: "image",
    evidenceStatus: "malformed",
  },
  {
    label: "image without an enabled delegate",
    config: 'images = ["alpine:3"]\n',
    kind: "image",
    evidenceStatus: "unsupported",
  },
  { label: "Maven project without a BOM", config: "", kind: "maven", evidenceStatus: "missing" },
];

for (const gap of gaps) {
  it(`scan reports a ${gap.label} and preserves the baseline`, { skip }, async () => {
    const f = makeFixture();
    try {
      toml(f, grype + gap.config);
      if (gap.kind === "maven") writeFileSync(join(f.dir, "pom.xml"), "<project/>\n");
      successfulScanner(f);
      const result = await scan(f, ["--strict", "--json"], env);
      assert.equal(result.exitCode, 1);
      const verdict = JSON.parse(result.stdout);
      assert.equal(verdict.coverage, "partial");
      assert.equal(verdict.scannerGate.ok, false);
      assert.ok(
        verdict.runs.some(
          (run: { id: string; status: string }) => run.id === "grype" && run.status === "ran",
        ),
      );
      assert.deepEqual(
        verdict.scopeGaps.map((row: { kind: string; evidenceStatus: string }) => [
          row.kind,
          row.evidenceStatus,
        ]),
        [[gap.kind, gap.evidenceStatus]],
      );

      const stored = join(f.dir, ".kit-baseline.json");
      writeFileSync(stored, baseline);
      const update = await scan(f, ["--update-baseline"], env);
      assert.equal(update.exitCode, 1);
      assert.match(update.stderr, /coverage cannot support a baseline update/i);
      assert.equal(readFileSync(stored, "utf8"), baseline);
    } finally {
      await rmTemp(f.dir);
    }
  });
}

it(
  "an unreadable Dockerfile directory also survives SARIF export and import as partial",
  {
    skip: skip || process.getuid?.() === 0,
  },
  async () => {
    const f = makeFixture();
    const folder = join(f.dir, "subproject");
    try {
      toml(f, grype + "images_from_dockerfiles = true\n");
      mkdirSync(folder);
      writeFileSync(join(folder, "Dockerfile"), "FROM alpine:3\n");
      successfulScanner(f);
      chmodSync(folder, 0);
      const exported = await scan(f, ["--sarif"], env);
      assert.equal(exported.exitCode, 0);
      const [run] = JSON.parse(exported.stdout).runs;
      assert.equal(run.invocations[0].executionSuccessful, false);
      const imageGaps = run.properties.scopeGaps.filter(
        (row: { kind: string }) => row.kind === "image",
      );
      assert.deepEqual(
        imageGaps.map((row: { target: string }) => row.target),
        ["subproject"],
      );
      const report = join(f.dir, "out.sarif");
      writeFileSync(report, exported.stdout);
      const imported = await runCli(["ingest", "sarif", report, "--json"], f.dir);
      assert.equal(imported.exitCode, 1);
      assert.equal(JSON.parse(imported.stdout).reportGap, "partial");
    } finally {
      chmodSync(folder, 0o700);
      await rmTemp(f.dir);
    }
  },
);

it(
  "strict air gap reports the requested image without starting an image scan",
  { skip },
  async () => {
    const f = makeFixture();
    try {
      toml(f, '[scan]\ndelegates = ["grype", "trivy"]\nimages = ["alpine:3"]\n');
      successfulScanner(f);
      tool(f, "trivy", `[ "$1" != image ] || exit 1\nprintf '%s\\n' '${EMPTY_SARIF}'`);
      const result = await scan(f, ["--strict", "--json"], { ...env, KIT_AIRGAP: "1" });
      assert.equal(result.exitCode, 1);
      const report = JSON.parse(result.stdout);
      assert.deepEqual(report.scopeGaps, [
        {
          kind: "image",
          target: "alpine:3",
          evidenceStatus: "unsupported",
          reason: "air-gap mode excludes network image scanners",
        },
      ]);
      assert.equal(
        report.runs.some((run: { id: string }) => run.id.includes(":image:")),
        false,
      );
    } finally {
      await rmTemp(f.dir);
    }
  },
);

it("a missing scope for a required Maven scanner fails without strict mode", { skip }, async () => {
  const f = makeFixture();
  try {
    toml(f, grype + '\n[governance.scan]\nrequired_scanners = ["grype"]\n');
    successfulScanner(f);
    writeFileSync(join(f.dir, "pom.xml"), "<project/>\n");
    const result = await scan(f, ["--json"], env);
    assert.equal(result.exitCode, 1);
    assert.equal(JSON.parse(result.stdout).scannerGate.ok, false);
  } finally {
    await rmTemp(f.dir);
  }
});

it(
  "a non-running selected scanner blocks a baseline update despite a successful peer",
  { skip },
  async () => {
    const f = makeFixture();
    try {
      toml(f, '[scan]\ndelegates = ["grype", "socket"]\n');
      successfulScanner(f);
      const stored = join(f.dir, ".kit-baseline.json");
      writeFileSync(stored, baseline);
      const result = await scan(f, ["--update-baseline"], env);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /coverage cannot support a baseline update/i);
      assert.equal(readFileSync(stored, "utf8"), baseline);
    } finally {
      await rmTemp(f.dir);
    }
  },
);

it("a base scanner requirement covers every scheduled project run", { skip }, async () => {
  const f = makeFixture();
  try {
    const probe = [
      'const { realpathSync } = require("node:fs");',
      "if (realpathSync(process.env.PWD) !== realpathSync(process.cwd())) process.exit(2);",
      `process.stdout.write(${JSON.stringify(EMPTY_SARIF)});`,
    ].join("\n");
    for (const app of ["client", "service"]) {
      mkdirSync(join(f.dir, app));
      writeFileSync(join(f.dir, app, "package.json"), "{}\n");
      writeFileSync(join(f.dir, app, "test"), probe);
    }
    toml(
      f,
      '[scan]\ndelegates = ["snyk"]\n[projects]\npaths = ["client", "service"]\n' +
        '[governance.scan]\nrequired_scanners = ["snyk"]\n',
    );
    symlinkSync(process.execPath, join(f.bin, "snyk"));
    const tokenEnv = { ...env, SNYK_TOKEN: "fixture" };
    const complete = await scan(f, ["--json"], tokenEnv);
    assert.equal(complete.exitCode, 0);
    assert.equal(JSON.parse(complete.stdout).scannerGate.ok, true);

    writeFileSync(join(f.dir, "service", "test"), "process.exit(2);\n");
    const incomplete = await scan(f, ["--json"], tokenEnv);
    assert.equal(incomplete.exitCode, 1);
    const { scannerGate } = JSON.parse(incomplete.stdout);
    assert.deepEqual(scannerGate.failures, ["required scanner snyk:service did not run (error)"]);
  } finally {
    await rmTemp(f.dir);
  }
});
