import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { launchFixture, NATIVE_RUN_TEST_WINDOW_MS } from "./launch-candidate.test-support.js";
import { launchIncomingCandidate } from "./launch-candidate.js";
import { hasNativeImageTool } from "./native-image.test-support.js";

const skip = !hasNativeImageTool || process.arch !== "arm64";
const fixture = (source: string, timeoutMs = 5000, dockerfile = "FROM scratch\n") =>
  launchFixture(
    () => source,
    timeoutMs,
    (root) => writeFileSync(join(root, "Dockerfile"), dockerfile),
    undefined,
    { requiredCheck: "dockerfile-secrets" },
  );

type Fixture = Awaited<ReturnType<typeof fixture>>;

function runCli(f: Fixture, policy: unknown) {
  const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
  const reportPath = join(f.root, "verification.json");
  const policyPath = join(f.root, "policy.json");
  writeFileSync(reportPath, JSON.stringify(f.verification));
  writeFileSync(policyPath, JSON.stringify(policy));
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "security",
      "incoming",
      "run",
      "--json",
      "--repo",
      f.repository,
      "--store",
      f.directory,
      "--snapshot-dir",
      f.source,
      "--verification",
      reportPath,
      "--policy",
      policyPath,
    ],
    {
      cwd: f.repository,
      encoding: "utf8",
      timeout: NATIVE_RUN_TEST_WINDOW_MS,
      env: { ...process.env, KIT_READ_ONLY: "0", KIT_AUDIT_ANCHOR: "0" },
    },
  );
  assert.ifError(result.error);
  return { status: result.status, receipt: JSON.parse(result.stdout) };
}

const scan = `
import { readFileSync } from "node:fs";
const file = "Dockerfile";
const body = readFileSync(new URL(file, import.meta.url), "utf8");
const hits = body.includes("APP_TOKEN=") ? [{file, line: 2, indicator: "APP_TOKEN"}] : [];
console.log(JSON.stringify({schema: "kit.dockerfile-inspection/v1", scanned: [file], hits}));
`;

it(
  "runs the approved inspector and applies the required verdict through the public CLI",
  { skip },
  async () => {
    const f = await fixture(scan);
    try {
      const { requiredCheck: _, ...ordinaryPolicy } = f.policy;
      assert.deepEqual(runCli(f, ordinaryPolicy), {
        status: 1,
        receipt: { ran: false, reason: "run-policy-mismatch" },
      });
      assert.equal(existsSync(f.policy.outputDirectory), false);

      writeFileSync(join(f.repository, "Dockerfile"), "FROM scratch\nENV APP_TOKEN=fixture\n");
      const passed = runCli(f, f.policy);
      assert.equal(passed.status, 0);
      assert.equal(passed.receipt.requiredCheck.status, "pass");
      assert.equal(passed.receipt.stdout + passed.receipt.stderr, "");
    } finally {
      f.cleanup();
    }
  },
);

it("fails the CLI check for a finding without printing its value", { skip }, async () => {
  const f = await fixture(scan, 5000, "FROM scratch\nENV APP_TOKEN=fixture-only-value\n");
  try {
    const result = runCli(f, f.policy);
    assert.equal(result.status, 1);
    assert.equal(result.receipt.outcome, "check-failed");
    assert.match(result.receipt.requiredCheck.detail, /Dockerfile:2 \(APP_TOKEN\)/);
    assert.doesNotMatch(JSON.stringify(result.receipt), /fixture-only-value/);
  } finally {
    f.cleanup();
  }
});

for (const [source, outcome] of [
  [
    'console.log(JSON.stringify({schema: "kit.dockerfile-inspection/v1", scanned: [], hits: []}));',
    "check-failed",
  ],
  ['throw new Error("fixture crash");', "exited"],
  ["setInterval(() => {}, 100);", "timed-out"],
] as const) {
  it(`fails the required CLI check on ${outcome} without complete evidence`, { skip }, async () => {
    const f = await fixture(source, outcome === "timed-out" ? 1000 : 5000);
    try {
      const result = runCli(f, f.policy);
      assert.equal(result.status, 1);
      assert.equal(result.receipt.ran, true);
      assert.equal(result.receipt.outcome, outcome);
      assert.equal(result.receipt.requiredCheck.status, "fail");
      assert.equal(result.receipt.requiredCheck.didNotRun, true);
      assert.equal(result.receipt.stdout + result.receipt.stderr, "");
    } finally {
      f.cleanup();
    }
  });
}

it(
  "refuses if the retained inspector changes to a link after initial verification",
  { skip },
  async (t) => {
    const f = await fixture(scan);
    try {
      const preflight = f.store.preflight.bind(f.store);
      const check = t.mock.method(f.store, "preflight", (...args: Parameters<typeof preflight>) => {
        const result = preflight(...args);
        if (result.verified) {
          const entry = join(f.source, "tree", "main.mjs");
          const saved = join(f.root, "saved-inspector.mjs");
          renameSync(entry, saved);
          symlinkSync(saved, entry);
        }
        return result;
      });
      assert.equal(launchIncomingCandidate(f).ran, false);
      assert.equal(check.mock.callCount(), 1);
      assert.ok(existsSync(join(f.root, "saved-inspector.mjs")));
      assert.equal(existsSync(f.policy.outputDirectory), false);
    } finally {
      f.cleanup();
    }
  },
);
