import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import { resolveToolBin, type ResolveDeps } from "./resolveTool.js";
import type { ExecResult } from "./execFileNoThrow.js";

describe("resolveToolBin", () => {
  it("resolves an existing tool (node) to an absolute path", async () => {
    const p = await resolveToolBin("node");
    assert.ok(p, "node should resolve via mise or PATH");
    // Cross-platform absolute-path check: POSIX paths start with "/", Windows
    // paths look like "C:\\…" — path.isAbsolute handles both (#43).
    assert.ok(isAbsolute(p!), `expected an absolute path, got: ${p}`);
  });

  it("returns null for a tool that does not exist anywhere", async () => {
    const p = await resolveToolBin("kit-definitely-not-a-real-tool-zzz");
    assert.equal(p, null);
  });
});

const res = (stdout: string, ok = true, stderr = ""): ExecResult => ({
  stdout,
  stderr,
  exitCode: ok ? 0 : 1,
  ok,
});

const MISE_PATH = "/home/u/.local/share/mise/installs/pipx-semgrep/1.0/bin/semgrep";
const SHIM_PATH = "/home/u/.local/share/mise/shims/semgrep";
const SHIM_ERROR = "mise ERROR osemgrep is not a valid shim";

function fake(responses: Record<string, ExecResult>, env: NodeJS.ProcessEnv, calls: string[] = []) {
  const deps: ResolveDeps = {
    exec: async (cmd, args) => {
      const key = [cmd, ...args].join(" ");
      calls.push(key);
      return responses[key] ?? res("", false);
    },
    env,
    platform: "linux",
  };
  return deps;
}

describe("resolveToolBin with mise shims on PATH", () => {
  const onShimPath = { PATH: "/home/u/.local/share/mise/shims:/usr/bin" };

  it("falls back to which when the installed binary is not a valid shim", async () => {
    const deps = fake(
      {
        "mise which semgrep": res(`${MISE_PATH}\n`),
        [`${MISE_PATH} --version`]: res("", false, SHIM_ERROR),
        "which semgrep": res(`${SHIM_PATH}\n`),
      },
      onShimPath,
    );
    assert.equal(await resolveToolBin("semgrep", deps), SHIM_PATH);
  });

  it("keeps the installed binary when it starts", async () => {
    const deps = fake(
      { "mise which semgrep": res(MISE_PATH), [`${MISE_PATH} --version`]: res("1.0") },
      onShimPath,
    );
    assert.equal(await resolveToolBin("semgrep", deps), MISE_PATH);
  });

  it("keeps the installed binary when which finds nothing either", async () => {
    const deps = fake(
      {
        "mise which semgrep": res(MISE_PATH),
        [`${MISE_PATH} --version`]: res("", false, SHIM_ERROR),
      },
      onShimPath,
    );
    assert.equal(await resolveToolBin("semgrep", deps), MISE_PATH);
  });

  it("does not treat a tool that rejects --version as broken", async () => {
    const deps = fake(
      {
        "mise which gitleaks": res("/m/gitleaks"),
        "/m/gitleaks --version": res("", false, "unknown flag"),
      },
      onShimPath,
    );
    assert.equal(await resolveToolBin("gitleaks", deps), "/m/gitleaks");
  });

  it("does not start the tool when mise shims are not on PATH", async () => {
    const calls: string[] = [];
    const deps = fake({ "mise which semgrep": res(MISE_PATH) }, { PATH: "/usr/bin" }, calls);
    assert.equal(await resolveToolBin("semgrep", deps), MISE_PATH);
    assert.deepEqual(calls, ["mise which semgrep"]);
  });
});
