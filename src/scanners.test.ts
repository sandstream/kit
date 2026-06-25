import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  dedupKey,
  mergeFindings,
  suppressBaselined,
  runScanners,
  airGapScanners,
  isAirGap,
  SCANNERS,
  type ScanDeps,
  type ScannerDef,
} from "./scanners.js";
import type { SecurityCheckResult } from "./check-security.js";

const f = (
  name: string,
  severity: SecurityCheckResult["severity"],
  detail = "",
): SecurityCheckResult => ({
  category: "dependency",
  name,
  status: "fail",
  detail,
  severity,
});

describe("dedupKey", () => {
  it("uses the CVE/GHSA id when present, else the name", () => {
    assert.equal(dedupKey(f("lodash@1: CVE-2021-23337", "high")), "CVE-2021-23337");
    assert.equal(dedupKey(f("pkg: GHSA-jf85-cpcp-j695", "high")), "GHSA-JF85-CPCP-J695");
    assert.equal(dedupKey(f("some-rule finding", "low")), "some-rule finding");
  });
});

describe("mergeFindings", () => {
  it("collapses the same CVE across scanners, keeps max severity + unions scanners", () => {
    const merged = mergeFindings([
      { id: "trivy", findings: [f("lodash: CVE-2021-23337", "medium")] },
      { id: "snyk", findings: [f("lodash@4: CVE-2021-23337", "high")] },
      { id: "grype", findings: [f("other: CVE-2020-1", "low")] },
    ]);
    assert.equal(merged.length, 2);
    const shared = merged.find((m) => dedupKey(m) === "CVE-2021-23337")!;
    assert.equal(shared.severity, "high"); // max of medium/high
    assert.deepEqual(shared.scanners.sort(), ["snyk", "trivy"]);
  });
  it("sorts by severity (critical first)", () => {
    const merged = mergeFindings([
      { id: "a", findings: [f("low: CVE-2020-1", "low"), f("crit: CVE-2020-2", "critical")] },
    ]);
    assert.equal(merged[0].severity, "critical");
  });
});

describe("runScanners (injected deps)", () => {
  const SARIF = JSON.stringify({
    runs: [
      {
        tool: { driver: { name: "trivy" } },
        results: [
          { ruleId: "CVE-2021-23337", level: "error", message: { text: "lodash CVE-2021-23337" } },
        ],
      },
    ],
  });
  const defs: ScannerDef[] = [
    { id: "snyk", bin: "snyk", args: [], format: "sarif", needsToken: "SNYK_TOKEN" },
    { id: "trivy", bin: "trivy", args: [], format: "sarif" },
    { id: "grype", bin: "grype", args: [], format: "sarif" },
  ];

  it("skips not-installed + no-token, runs the rest, merges", async () => {
    const deps: ScanDeps = {
      resolve: async (bin) => (bin === "grype" ? null : `/usr/bin/${bin}`), // grype absent
      run: async () => ({ ok: false, stdout: SARIF }), // non-zero exit + SARIF (findings present)
      hasEnv: () => false, // no SNYK_TOKEN
      detect: () => true,
    };
    const { merged, runs } = await runScanners(deps, defs);
    const byId = Object.fromEntries(runs.map((r) => [r.id, r.status]));
    assert.equal(byId.snyk, "no-token");
    assert.equal(byId.grype, "not-installed");
    assert.equal(byId.trivy, "ran");
    assert.equal(merged.length, 1); // trivy's one CVE
  });

  it("marks a scanner whose output we cannot parse as error, NOT ran-clean", async () => {
    const only: ScannerDef[] = [{ id: "trivy", bin: "trivy", args: [], format: "sarif" }];
    const deps: ScanDeps = {
      resolve: async (bin) => `/usr/bin/${bin}`,
      // scanner printed a junk error blob to stdout (e.g. a stack trace / wrong format)
      run: async () => ({ ok: false, stdout: "panic: could not open db\n" }),
      hasEnv: () => true,
      detect: () => true,
    };
    const { merged, runs } = await runScanners(deps, only);
    assert.equal(runs[0].status, "error", "unparseable output must surface as error");
    assert.equal(merged.length, 0);
  });

  it("treats a valid but empty SARIF as ran/0 (not error)", async () => {
    const only: ScannerDef[] = [{ id: "trivy", bin: "trivy", args: [], format: "sarif" }];
    const deps: ScanDeps = {
      resolve: async (bin) => `/usr/bin/${bin}`,
      run: async () => ({ ok: true, stdout: JSON.stringify({ runs: [] }) }),
      hasEnv: () => true,
      detect: () => true,
    };
    const { runs } = await runScanners(deps, only);
    assert.equal(runs[0].status, "ran");
    assert.equal(runs[0].findings, 0);
  });

  it("exitGate scanner: clean exit → ran/0, no finding (stdout ignored)", async () => {
    const only: ScannerDef[] = [
      { id: "socket", bin: "socket", args: ["ci"], format: "sarif", exitGate: true },
    ];
    const deps: ScanDeps = {
      resolve: async (bin) => `/usr/bin/${bin}`,
      run: async () => ({ ok: true, stdout: "ok\n" }),
      hasEnv: () => true,
      detect: () => true,
    };
    const { merged, runs } = await runScanners(deps, only);
    assert.equal(runs[0].status, "ran");
    assert.equal(runs[0].findings, 0);
    assert.equal(merged.length, 0);
  });

  it("exitGate scanner: non-zero exit → one high-severity policy violation (never false-green)", async () => {
    const only: ScannerDef[] = [
      { id: "socket", bin: "socket", args: ["ci"], format: "sarif", exitGate: true },
    ];
    const deps: ScanDeps = {
      resolve: async (bin) => `/usr/bin/${bin}`,
      run: async () => ({ ok: false, stdout: "" }),
      hasEnv: () => true,
      detect: () => true,
    };
    const { merged, runs } = await runScanners(deps, only);
    assert.equal(runs[0].status, "ran");
    assert.equal(runs[0].findings, 1);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].severity, "high");
  });
});

describe("isAirGap", () => {
  it("is true for 1/true/yes, false otherwise", () => {
    assert.equal(isAirGap({ KIT_AIRGAP: "1" }), true);
    assert.equal(isAirGap({ KIT_AIRGAP: "true" }), true);
    assert.equal(isAirGap({ KIT_AIRGAP: "YES" }), true);
    assert.equal(isAirGap({ KIT_AIRGAP: "0" }), false);
    assert.equal(isAirGap({}), false);
  });
});

describe("airGapScanners", () => {
  it("is a no-op when disabled", () => {
    const plan = airGapScanners(SCANNERS, false);
    assert.equal(plan.scanners, SCANNERS);
    assert.deepEqual(plan.dropped, []);
    assert.deepEqual(plan.env, {});
  });

  it("drops cloud-only scanners and folds offline args/env for the rest", () => {
    const plan = airGapScanners(SCANNERS, true);
    // cloud-only (snyk, semgrep, socket) are excluded
    assert.deepEqual(plan.dropped.sort(), ["semgrep", "snyk", "socket"]);
    assert.ok(
      !plan.scanners.some((s) => s.id === "snyk" || s.id === "semgrep" || s.id === "socket"),
    );
    // trivy gets its offline flags appended
    const trivy = plan.scanners.find((s) => s.id === "trivy")!;
    assert.ok(trivy.args.includes("--offline-scan") && trivy.args.includes("--skip-db-update"));
    // osv-scanner gets --offline
    assert.ok(plan.scanners.find((s) => s.id === "osv-scanner")!.args.includes("--offline"));
    // grype contributes offline env, not args
    assert.equal(plan.env.GRYPE_DB_AUTO_UPDATE, "false");
  });

  it("does not mutate the original registry", () => {
    const before = JSON.stringify(SCANNERS);
    airGapScanners(SCANNERS, true);
    assert.equal(JSON.stringify(SCANNERS), before);
  });
});

describe("isAirGap", () => {
  it("is true for 1/true/yes, false otherwise", () => {
    assert.equal(isAirGap({ KIT_AIRGAP: "1" }), true);
    assert.equal(isAirGap({ KIT_AIRGAP: "true" }), true);
    assert.equal(isAirGap({ KIT_AIRGAP: "YES" }), true);
    assert.equal(isAirGap({ KIT_AIRGAP: "0" }), false);
    assert.equal(isAirGap({}), false);
  });
});

describe("airGapScanners", () => {
  it("is a no-op when disabled", () => {
    const plan = airGapScanners(SCANNERS, false);
    assert.equal(plan.scanners, SCANNERS);
    assert.deepEqual(plan.dropped, []);
    assert.deepEqual(plan.env, {});
  });

  it("drops cloud-only scanners and folds offline args/env for the rest", () => {
    const plan = airGapScanners(SCANNERS, true);
    // cloud-only (snyk, semgrep, socket) are excluded
    assert.deepEqual(plan.dropped.sort(), ["semgrep", "snyk", "socket"]);
    assert.ok(
      !plan.scanners.some((s) => s.id === "snyk" || s.id === "semgrep" || s.id === "socket"),
    );
    // trivy gets its offline flags appended
    const trivy = plan.scanners.find((s) => s.id === "trivy")!;
    assert.ok(trivy.args.includes("--offline-scan") && trivy.args.includes("--skip-db-update"));
    // osv-scanner gets --offline
    assert.ok(plan.scanners.find((s) => s.id === "osv-scanner")!.args.includes("--offline"));
    // grype contributes offline env, not args
    assert.equal(plan.env.GRYPE_DB_AUTO_UPDATE, "false");
  });

  it("does not mutate the original registry", () => {
    const before = JSON.stringify(SCANNERS);
    airGapScanners(SCANNERS, true);
    assert.equal(JSON.stringify(SCANNERS), before);
  });
});

describe("suppressBaselined", () => {
  const merged = mergeFindings([
    {
      id: "trivy",
      findings: [f("x: CVE-2021-23337", "high"), f("verify-suite: stripe-token", "critical")],
    },
  ]);
  it("drops findings whose key is in the baseline, keeps the rest", () => {
    const accepted = new Set(["verify-suite: stripe-token"]); // the FP, baselined (dedupKey = name)
    const { kept, suppressed } = suppressBaselined(merged, accepted);
    assert.equal(suppressed, 1);
    assert.equal(kept.length, 1);
    assert.equal(dedupKey(kept[0]), "CVE-2021-23337");
  });
  it("no-ops on an empty baseline", () => {
    assert.equal(suppressBaselined(merged, new Set()).suppressed, 0);
  });
});
