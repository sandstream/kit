import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { launchFixture, NATIVE_RUN_TEST_WINDOW_MS } from "./launch-candidate.test-support.js";
import { launchIncomingCandidate } from "./launch-candidate.js";
import { hasNativeImageTool } from "./native-image.test-support.js";

function syntheticWorkload({ authority, sentinel }: { authority: string; sentinel: string }) {
  return [
    'import fs from "node:fs";',
    'import {spawnSync} from "node:child_process";',
    'import net from "node:net";',
    'const attempt = (f) => { try { f(); return "allowed"; } catch (e) { return e.code; } };',
    'fs.writeFileSync("answer", "retained input");',
    "const network = await new Promise((resolve) => {",
    '  const socket = net.connect({host:"127.0.0.1",port:1});',
    '  socket.on("error", (e) => resolve(e.code));',
    '  socket.on("connect", () => { socket.destroy(); resolve("allowed"); });',
    "});",
    "console.log(JSON.stringify({",
    "  authority: attempt(() => fs.openSync(" + JSON.stringify(authority) + ', "r+")),',
    "  sentinel: attempt(() => fs.readFileSync(" + JSON.stringify(sentinel) + ")),",
    "  outside: attempt(() => fs.writeFileSync(" + JSON.stringify(sentinel) + ', "changed")),',
    '  child: spawnSync(process.execPath, ["--version"]).error?.code ?? "allowed",',
    "  credential: process.env.KIT_SYNTHETIC_SECRET ?? null, network,",
    "}));",
  ].join("\n");
}

it(
  "runs the signed retained program and rejects a different policy via the CLI",
  { skip: !hasNativeImageTool || process.arch !== "arm64" },
  async () => {
    const f = await launchFixture(syntheticWorkload);
    try {
      const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
      const report = join(f.root, "verification.json");
      const policyFile = join(f.root, "policy.json");
      writeFileSync(report, JSON.stringify(f.verification));
      const call = (...args: string[]) =>
        spawnSync(
          process.execPath,
          [
            cli,
            "security",
            "incoming",
            ...args,
            "--json",
            "--repo",
            f.repository,
            "--store",
            f.directory,
          ],
          {
            cwd: f.repository,
            encoding: "utf8",
            timeout: NATIVE_RUN_TEST_WINDOW_MS,
            env: {
              ...process.env,
              KIT_READ_ONLY: "0",
              KIT_AUDIT_ANCHOR: "0",
              KIT_SYNTHETIC_SECRET: "host only",
            },
          },
        );
      const run = () =>
        call("run", "--snapshot-dir", f.source, "--verification", report, "--policy", policyFile);
      writeFileSync(policyFile, JSON.stringify({ ...f.policy, timeoutMs: f.policy.timeoutMs + 1 }));
      const wrong = run();
      assert.equal(wrong.status, 1, wrong.stderr);
      assert.deepEqual(JSON.parse(wrong.stdout), { ran: false, reason: "run-policy-mismatch" });
      assert.equal(existsSync(f.policy.outputDirectory), false);
      writeFileSync(policyFile, JSON.stringify(f.policy));
      const digest = call("run-policy", "--policy", policyFile);
      assert.equal(digest.status, 0, digest.stderr);
      assert.equal(JSON.parse(digest.stdout).policyDigest, f.prepared.policyDigest);
      writeFileSync(join(f.repository, "main.mjs"), 'throw new Error("changed original");');
      const result = run();
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const receipt = JSON.parse(result.stdout);
      assert.equal(receipt.ran, true);
      assert.equal(receipt.outcome, "exited");
      assert.match(receipt.runId, /^[a-f0-9]{64}$/);
      const checks = JSON.parse(receipt.stdout);
      for (const key of ["authority", "sentinel", "outside", "child", "network"])
        assert.ok(["EPERM", "EACCES"].includes(checks[key]), JSON.stringify(checks));
      assert.equal(checks.credential, null);
      assert.equal(
        readFileSync(join(f.policy.outputDirectory, "answer"), "utf8"),
        "retained input",
      );
      assert.equal(readFileSync(join(f.root, "secret"), "utf8"), "synthetic secret");
    } finally {
      f.cleanup();
    }
  },
);

it(
  "refuses signed preinstalled packages until runtime package provenance is verified",
  {
    skip: !hasNativeImageTool || process.arch !== "arm64",
  },
  async () => {
    const f = await launchFixture(
      () => 'throw new Error("this entry is never loaded")',
      5000,
      (repo) => {
        const installed = join(repo, "nested", "node_modules");
        mkdirSync(installed, { recursive: true });
        writeFileSync(join(installed, "extra.js"), "export default 1");
      },
    );
    try {
      assert.deepEqual(launchIncomingCandidate(f), {
        ran: false,
        reason: "run-dependencies-unproven",
      });
      assert.equal(existsSync(f.policy.outputDirectory), false);
    } finally {
      f.cleanup();
    }
  },
);
