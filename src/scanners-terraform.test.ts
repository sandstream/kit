import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  airGapScanners,
  runScanners,
  SCANNERS,
  SEMGREP_EXCLUDES,
  scannerEnv,
  scanHealthGate,
  dropProviderExclusion,
  type ScanDeps,
  type ScannerDef,
} from "./scanners.js";

const def = (id: string): ScannerDef => {
  const d = SCANNERS.find((s) => s.id === id);
  assert.ok(d, `scanner ${id} is registered`);
  return d;
};

describe("downloaded provider binaries stay out of the scan", () => {
  for (const id of ["trivy", "grype", "osv-scanner", "trivy-config"]) {
    it(`${id} excludes .terraform/providers and nothing broader`, () => {
      const args = def(id).args;
      assert.ok(
        args.some((a) => a.includes(".terraform/providers")),
        `${id} args name the providers directory`,
      );
      // The lock file and the .tf sources live next to it and must still be scanned.
      assert.ok(!args.some((a) => /\.terraform(\/?\*{0,2})?$/.test(a)));
    });
  }

  it("semgrep excludes it too", () => {
    assert.ok(SEMGREP_EXCLUDES.some((g) => g.includes(".terraform/providers")));
  });

  it("the exclusion survives the air-gap plan", () => {
    const plan = airGapScanners(SCANNERS, true, {});
    for (const id of ["trivy", "grype", "osv-scanner", "trivy-config"]) {
      const s = plan.scanners.find((x) => x.id === id);
      assert.ok(
        s?.args.some((a) => a.includes(".terraform/providers")),
        id,
      );
    }
  });
});

describe("trivy config mode for infrastructure code", () => {
  it("runs trivy in config mode with sarif output", () => {
    const d = def("trivy-config");
    assert.equal(d.bin, "trivy");
    assert.equal(d.args[0], "config");
    assert.ok(d.args.includes("sarif"));
  });

  it("applies when a .tf file or a Dockerfile exists", () => {
    assert.deepEqual([...(def("trivy-config").detect ?? [])].sort(), ["*.tf", "Dockerfile"]);
  });

  it("does not fetch check updates in air-gap mode", () => {
    const plan = airGapScanners([def("trivy-config")], true, {});
    assert.ok(plan.scanners[0].args.includes("--skip-check-update"));
  });
});

describe("a scanner that errors says why", () => {
  const one: ScannerDef = { id: "osv-scanner", bin: "osv-scanner", args: [], format: "osv" };
  const deps = (run: ScanDeps["run"]): ScanDeps => ({
    resolve: async () => "/bin/x",
    run,
    hasEnv: () => true,
    detect: () => true,
  });

  it("carries the first stderr line, without control characters", async () => {
    const { runs } = await runScanners(
      deps(async () => ({
        ok: false,
        stdout: "",
        stderr: "\u001b[31mfatal: no lockfile found\u001b[0m\u0007\nsecond line",
      })),
      [one],
    );
    assert.equal(runs[0].status, "error");
    assert.equal(runs[0].reason, "fatal: no lockfile found");
  });

  it("caps a long line", async () => {
    const { runs } = await runScanners(
      deps(async () => ({ ok: false, stdout: "", stderr: "x".repeat(900) })),
      [one],
    );
    assert.ok((runs[0].reason ?? "").length <= 200);
  });

  it("redacts a credential in the line", async () => {
    const { runs } = await runScanners(
      deps(async () => ({
        ok: false,
        stdout: "",
        stderr: "auth failed with ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      })),
      [one],
    );
    assert.ok(!(runs[0].reason ?? "").includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
  });

  it("names unparsable output when there is no stderr", async () => {
    const { runs } = await runScanners(
      deps(async () => ({ ok: false, stdout: "junk", stderr: "" })),
      [one],
    );
    assert.equal(runs[0].status, "error");
    assert.match(runs[0].reason ?? "", /not valid JSON/);
  });

  it("has no reason when the scanner ran", async () => {
    const { runs } = await runScanners(
      deps(async () => ({ ok: true, stdout: '{"results":[]}', stderr: "" })),
      [one],
    );
    assert.equal(runs[0].status, "ran");
    assert.equal(runs[0].reason, undefined);
  });
});

describe("osv-scanner with nothing to scan", () => {
  const osv = SCANNERS.find((x) => x.id === "osv-scanner") as ScannerDef;
  const deps = (r: {
    ok: boolean;
    stdout: string;
    stderr?: string;
    exitCode?: number;
  }): ScanDeps => ({
    resolve: async () => "/bin/osv",
    run: async () => r,
    hasEnv: () => true,
    detect: () => true,
  });

  it("exit 128 with no output is not-applicable, not an error", async () => {
    const { runs } = await runScanners(
      deps({
        ok: false,
        stdout: "",
        exitCode: 128,
        stderr: "Scanning dir .\nNo package sources found, --help for usage information.",
      }),
      [osv],
    );
    assert.equal(runs[0].status, "not-applicable");
    assert.equal(runs[0].noTarget, true);
    assert.match(runs[0].reason ?? "", /No package sources found/);
  });

  it("exit 127 with no output is still an error", async () => {
    const { runs } = await runScanners(
      deps({ ok: false, stdout: "", exitCode: 127, stderr: "boom" }),
      [osv],
    );
    assert.equal(runs[0].status, "error");
  });

  it("the reason is the line that names the failure, not a progress line", async () => {
    const { runs } = await runScanners(
      deps({
        ok: false,
        stdout: "",
        exitCode: 127,
        stderr: "Scanning dir .\nStarting walk\nError: cannot read lockfile\nbye",
      }),
      [osv],
    );
    assert.equal(runs[0].reason, "Error: cannot read lockfile");
  });

  it("falls back to the last line when no line names a failure", async () => {
    const { runs } = await runScanners(
      deps({
        ok: false,
        stdout: "",
        exitCode: 127,
        stderr: "Scanning dir .\nsomething odd happened",
      }),
      [osv],
    );
    assert.equal(runs[0].reason, "something odd happened");
  });
});

describe("scannerEnv", () => {
  it("points PWD at the real working directory so Go tools resolve exclusions", () => {
    const env = scannerEnv({ PWD: "/var/stale", A: "1" }, { B: "2" }, "/private/var/real");
    assert.equal(env.PWD, "/private/var/real");
    assert.equal(env.A, "1");
    assert.equal(env.B, "2");
  });
});

describe("a tracked provider directory is scanned", () => {
  for (const id of ["trivy", "grype", "osv-scanner", "trivy-config"]) {
    it(`${id}: dropProviderExclusion removes the exclusion and nothing else`, () => {
      const d = def(id);
      const dropped = dropProviderExclusion(d);
      assert.ok(!dropped.args.some((a) => a.includes(".terraform/providers")));
      // the target and the output flags are untouched
      assert.equal(dropped.args.length, d.args.length - 2);
      assert.ok(dropped.args.includes("sarif") || dropped.args.includes("json"));
    });
  }

  it("keeps a def that has no exclusion as it is", () => {
    const d = { id: "x", bin: "x", args: ["a", "b"], format: "sarif" } as ScannerDef;
    assert.deepEqual(dropProviderExclusion(d).args, ["a", "b"]);
  });

  it("drops the semgrep exclusion from the built args", () => {
    const d = dropProviderExclusion({
      id: "semgrep",
      bin: "semgrep",
      format: "sarif",
      args: ["scan", "--exclude", "node_modules", "--exclude", ".terraform/providers", "."],
    });
    assert.deepEqual(d.args, ["scan", "--exclude", "node_modules", "."]);
  });
});

describe("nothing to scan does not satisfy a required scanner", () => {
  const run = { id: "osv-scanner", status: "not-applicable" as const, findings: 0, noTarget: true };

  it("a required scanner with nothing to scan fails the gate and says so", () => {
    const g = scanHealthGate([run], { requiredScanners: ["osv-scanner"] });
    assert.equal(g.ok, false);
    assert.match(g.failures[0], /osv-scanner/);
    assert.match(g.failures[0], /nothing to scan/);
  });

  it("an optional scanner with nothing to scan passes, also under strict", () => {
    assert.equal(scanHealthGate([run], { strict: true }).ok, true);
  });

  it("an ordinary not-applicable stays a legitimate skip for a required scanner", () => {
    const g = scanHealthGate([{ ...run, noTarget: undefined }], {
      requiredScanners: ["osv-scanner"],
    });
    assert.equal(g.ok, true);
  });
});
