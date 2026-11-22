import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createCliContractFixture } from "./cli-contract.test-support.js";
import {
  crateDoc,
  daysAgo,
  startStubRegistry,
  UNREACHABLE,
  type StubRegistry,
} from "./triage-registry.test-support.js";

const source = import.meta.url.endsWith(".ts");
const cli = fileURLToPath(new URL(source ? "./cli.ts" : "./cli.js", import.meta.url));
const loader = source ? ["--import", import.meta.resolve("tsx")] : [];

/**
 * The real CLI, the real gate and the real triage; only the registries are local stubs, named by
 * the mirror variables. The child runs asynchronously so this process can answer its requests.
 */
let stub: StubRegistry;
const fixture = createCliContractFixture();

before(async () => {
  stub = await startStubRegistry({
    "/api/v1/crates/fast-anything": crateDoc([["0.1.0", 1]], 12),
    "/api/v1/crates/fast-anything/owners": { users: [{ login: "someone" }] },
    "/api/v1/crates/ripgrep": crateDoc([["14.1.1", 400]], 9_000_000),
    "/api/v1/crates/ripgrep/owners": { users: [{ login: "alice" }] },
    "/example.com/young/tool/@latest": { Version: "v0.1.0", Time: daysAgo(1) },
    "/example.com/young/tool/@v/list": "v0.1.0\n",
    "/example.com/old/@latest": { Version: "v1.9.0", Time: daysAgo(400) },
    "/example.com/old/@v/list": "v1.8.0\nv1.9.0\n",
  });
});
after(async () => {
  await stub.close();
  fixture.cleanup();
});

function gate(command: string, env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((done, fail) => {
    const child = spawn(process.execPath, [...loader, cli, "gate-bash"], {
      cwd: fixture.cwd,
      env: {
        ...fixture.env,
        KIT_CRATES_REGISTRY: stub.url,
        KIT_GOPROXY: stub.url,
        KIT_OSV_API: stub.url,
        ...env,
      },
    });
    let [stdout, stderr] = ["", ""];
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", fail);
    child.on("close", (status) => done({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify({ tool_name: "Bash", tool_input: { command } }));
  });
}

describe("kit gate-bash: cargo installs through the real CLI", () => {
  it("refuses cargo install of a one-day-old crate on the cooling hold (exit 2)", async () => {
    const r = await gate("cargo install fast-anything");
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /install-gate: BLOCKED: triage did not pass \(cargo fast-anything\)/);
    assert.match(r.stderr, /cooling: 0\.1\.0 was published 1 days ago, limit 14/);
    assert.ok(stub.asked.includes("GET /api/v1/crates/fast-anything"));
  });

  it("lets cargo install --path . through without asking any registry (exit 0)", async () => {
    const before = stub.asked.length;
    const r = await gate("cargo install --path .");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stderr, /BLOCKED/);
    assert.equal(stub.asked.length, before);
  });

  it("lets cargo install of an old crate through after triaging it (exit 0)", async () => {
    const r = await gate("cargo install ripgrep");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(stub.asked.includes("GET /api/v1/crates/ripgrep"));
  });

  it("refuses cargo install when crates.io cannot be reached (exit 2, fail-closed)", async () => {
    const r = await gate("cargo install ripgrep", { KIT_CRATES_REGISTRY: UNREACHABLE });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(
      r.stderr,
      /BLOCKED: triage did not pass \(cargo ripgrep\).*registry could not be read/,
    );
  });

  it("refuses cargo install from a git source and points at kit triage repo (exit 2)", async () => {
    const before = stub.asked.length;
    const r = await gate("cargo install --git https://github.com/acme/tool");
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /BLOCKED: UNVERIFIED SOURCE: --git\..*kit triage repo <url>/);
    assert.equal(stub.asked.length, before);
  });
});

describe("kit gate-bash: go and brew installs through the real CLI", () => {
  it("refuses go install of a one-day-old release and lets an old one through", async () => {
    const young = await gate("go install example.com/young/tool@latest");
    assert.equal(young.status, 2, young.stdout + young.stderr);
    assert.match(young.stderr, /triage did not pass \(go example\.com\/young\/tool@latest\)/);
    assert.match(young.stderr, /cooling: v0\.1\.0 was published 1 days ago/);
    const old = await gate("go install example.com/old/cmd/tool@latest");
    assert.equal(old.status, 0, old.stdout + old.stderr);
  });

  it("lets go install of the module on disk through (exit 0)", async () => {
    for (const command of ["go install .", "go install ./cmd/x"]) {
      const r = await gate(command);
      assert.equal(r.status, 0, command + r.stderr);
    }
  });

  it("refuses brew install when the formula cannot be triaged: no brew on the fixture PATH (exit 2)", async () => {
    const r = await gate("brew install jq", { PATH: "" });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /BLOCKED: triage did not pass \(brew jq\): brew info failed for 'jq'/);
  });
});
