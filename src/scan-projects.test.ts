import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { expandPerProject } from "./scan-projects.js";
import { runScanners, type ScanDeps, type ScannerDef } from "./scanners.js";

const snyk: ScannerDef = {
  id: "snyk",
  bin: "snyk",
  args: ["test", "--sarif"],
  format: "sarif",
  needsToken: "SNYK_TOKEN",
};
const trivy: ScannerDef = { id: "trivy", bin: "trivy", args: ["fs", "."], format: "sarif" };

describe("expandPerProject", () => {
  it("runs a per-project scanner once in each project directory", () => {
    const out = expandPerProject([snyk, trivy], ["axfood-backend", "axfood-frontend"]);
    assert.deepEqual(
      out.map((s) => [s.id, s.cwd]),
      [
        ["snyk:axfood-backend", "axfood-backend"],
        ["snyk:axfood-frontend", "axfood-frontend"],
        ["trivy", undefined],
      ],
    );
  });

  it("keeps every other field of the scanner", () => {
    const [first] = expandPerProject([snyk], ["a"]);
    assert.equal(first?.bin, "snyk");
    assert.deepEqual(first?.args, ["test", "--sarif"]);
    assert.equal(first?.needsToken, "SNYK_TOKEN");
  });

  it("changes nothing when no project paths are declared", () => {
    assert.deepEqual(expandPerProject([snyk, trivy], []), [snyk, trivy]);
  });

  it("leaves a scanner that already has a directory alone", () => {
    const pinned = { ...snyk, cwd: "elsewhere" };
    assert.deepEqual(expandPerProject([pinned], ["a"]), [pinned]);
  });
});

describe("runScanners with a scanner directory", () => {
  it("passes the project directory to the run and names each run by project", async () => {
    const seen: (string | undefined)[] = [];
    const deps: ScanDeps = {
      resolve: async (bin) => `/usr/bin/${bin}`,
      run: async (_bin, _args, _timeout, cwd) => {
        seen.push(cwd);
        return { ok: true, stdout: JSON.stringify({ runs: [] }) };
      },
      hasEnv: () => true,
      detect: () => true,
    };
    const { runs } = await runScanners(deps, expandPerProject([snyk], ["backend", "frontend"]));
    assert.deepEqual(seen, ["backend", "frontend"]);
    assert.deepEqual(
      runs.map((r) => [r.id, r.status]),
      [
        ["snyk:backend", "ran"],
        ["snyk:frontend", "ran"],
      ],
    );
  });
});
