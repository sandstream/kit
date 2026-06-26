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
  buildSemgrepArgs,
  semgrepConfig,
  isLocalSemgrepConfig,
  scanHealthGate,
  verifyAirGapScanners,
  DEFAULT_SEMGREP_CONFIG,
  SEMGREP_EXCLUDES,
  type ScanDeps,
  type ScannerDef,
  type ScannerRun,
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

describe("semgrep invocation (privacy + config, no `--config auto`)", () => {
  it("semgrepConfig defaults to p/default and honors KIT_SEMGREP_CONFIG", () => {
    assert.equal(semgrepConfig({}), DEFAULT_SEMGREP_CONFIG);
    assert.equal(semgrepConfig({ KIT_SEMGREP_CONFIG: undefined }), DEFAULT_SEMGREP_CONFIG);
    assert.equal(semgrepConfig({ KIT_SEMGREP_CONFIG: "  " }), DEFAULT_SEMGREP_CONFIG);
    assert.equal(semgrepConfig({ KIT_SEMGREP_CONFIG: "p/owasp-top-ten" }), "p/owasp-top-ten");
    assert.equal(semgrepConfig({ KIT_SEMGREP_CONFIG: " ./local-rules.yml " }), "./local-rules.yml");
  });

  it("buildSemgrepArgs never uses telemetry-forcing `auto` and always sets metrics off", () => {
    for (const mode of ["sarif", "json"] as const) {
      const args = buildSemgrepArgs({ mode, config: "p/default" });
      assert.ok(!args.includes("auto"), `${mode}: must not contain 'auto'`);
      const m = args.indexOf("--metrics");
      assert.ok(m >= 0 && args[m + 1] === "off", `${mode}: --metrics off`);
      const c = args.indexOf("--config");
      assert.ok(c >= 0 && args[c + 1] === "p/default", `${mode}: --config p/default`);
      for (const glob of SEMGREP_EXCLUDES) {
        assert.ok(args.includes(glob), `${mode}: excludes ${glob}`);
      }
    }
  });

  it("sarif mode emits --sarif and scans '.'; json mode emits --json without a positional target", () => {
    const sarif = buildSemgrepArgs({ mode: "sarif", config: "p/default" });
    assert.ok(sarif.includes("--sarif"));
    assert.equal(sarif[sarif.length - 1], ".");

    const json = buildSemgrepArgs({ mode: "json", config: "p/default" });
    assert.ok(json.includes("--json"));
    assert.ok(json.includes("--no-rewrite-rule-ids"));
    assert.ok(!json.includes("--sarif"));
  });

  it("the registered semgrep scanner uses the built args (no `auto`) and is opt-in", () => {
    const semgrep = SCANNERS.find((s) => s.id === "semgrep");
    assert.ok(semgrep, "semgrep scanner registered");
    assert.ok(!semgrep!.args.includes("auto"), "registered args must not contain 'auto'");
    assert.ok(semgrep!.args.includes("--metrics"), "registered args set --metrics");
    // SAST is opt-in: gated on KIT_SEMGREP_CONFIG so it never runs (slow + networked)
    // by default. The runner skips a needsToken scanner whose env var is unset.
    assert.equal(semgrep!.needsToken, "KIT_SEMGREP_CONFIG", "semgrep gated on KIT_SEMGREP_CONFIG");
  });
});

describe("isLocalSemgrepConfig (air-gap egress gate)", () => {
  it("registry/auto configs are NOT local (would egress)", () => {
    assert.equal(isLocalSemgrepConfig("p/default"), false);
    assert.equal(isLocalSemgrepConfig("auto"), false);
    assert.equal(isLocalSemgrepConfig("r/x"), false);
    assert.equal(isLocalSemgrepConfig(""), false);
    assert.equal(isLocalSemgrepConfig("  "), false);
  });
  it("filesystem ruleset paths are local (run air-gapped)", () => {
    assert.equal(isLocalSemgrepConfig("./rules.yml"), true);
    assert.equal(isLocalSemgrepConfig("/abs/rules"), true);
    assert.equal(isLocalSemgrepConfig(" ./local-rules.yml "), true);
  });
});

describe("airGapScanners — local semgrep is allowed offline, registry dropped", () => {
  it("keeps semgrep when KIT_SEMGREP_CONFIG is a local ruleset path", () => {
    const plan = airGapScanners(SCANNERS, true, { KIT_SEMGREP_CONFIG: "./rules.yml" });
    assert.ok(!plan.dropped.includes("semgrep"), "local-config semgrep must not be dropped");
    const semgrep = plan.scanners.find((s) => s.id === "semgrep");
    assert.ok(semgrep, "semgrep present in air-gap plan");
    const i = semgrep!.args.indexOf("--config");
    assert.equal(semgrep!.args[i + 1], "./rules.yml", "args rebuilt against the local ruleset");
  });
  it("drops semgrep when the config is a registry pack (egress)", () => {
    const plan = airGapScanners(SCANNERS, true, { KIT_SEMGREP_CONFIG: "p/default" });
    assert.ok(plan.dropped.includes("semgrep"));
    assert.ok(!plan.scanners.some((s) => s.id === "semgrep"));
  });
});

describe("scanHealthGate (reduce scanner health to exit)", () => {
  const runs = (entries: [string, ScannerRun["status"]][]): ScannerRun[] =>
    entries.map(([id, status]) => ({ id, status, findings: 0 }));

  it("required scanner that ran => ok", () => {
    const gate = scanHealthGate(runs([["trivy", "ran"]]), { requiredScanners: ["trivy"] });
    assert.equal(gate.ok, true);
    assert.deepEqual(gate.failures, []);
  });
  it("required scanner that errored => not ok, names the scanner", () => {
    const gate = scanHealthGate(runs([["trivy", "error"]]), { requiredScanners: ["trivy"] });
    assert.equal(gate.ok, false);
    assert.ok(gate.failures.some((f) => f.includes("trivy")));
  });
  it("required scanner absent from the run set => not ok", () => {
    const gate = scanHealthGate(runs([["grype", "ran"]]), { requiredScanners: ["trivy"] });
    assert.equal(gate.ok, false);
    assert.ok(gate.failures.some((f) => f.includes("trivy") && f.includes("not in scan plan")));
  });
  it("strict + any non-running scanner => not ok", () => {
    const gate = scanHealthGate(runs([["trivy", "not-installed"]]), { strict: true });
    assert.equal(gate.ok, false);
    assert.ok(gate.failures.some((f) => f.includes("trivy")));
  });
  it("default (no strict, no required) + non-running scanner => ok but warns", () => {
    const gate = scanHealthGate(runs([["trivy", "error"]]));
    assert.equal(gate.ok, true);
    assert.equal(gate.failures.length, 0);
    assert.ok(gate.warnings.some((w) => w.includes("trivy")));
  });
  it("not-applicable is a legitimate skip — never a failure even when strict", () => {
    const gate = scanHealthGate(runs([["snyk", "not-applicable"]]), { strict: true });
    assert.equal(gate.ok, true);
    assert.equal(gate.warnings.length, 0);
  });
});

describe("verifyAirGapScanners (provable zero-egress reducer)", () => {
  it("all-local plan => pass", () => {
    const local: ScannerDef[] = [
      { id: "trivy", bin: "trivy", args: [], format: "sarif" },
      { id: "osv-scanner", bin: "osv-scanner", args: [], format: "osv" },
      { id: "semgrep", bin: "semgrep", args: [], format: "sarif", cloudOnly: true },
    ];
    const report = verifyAirGapScanners(local, { semgrepConfig: "./rules.yml" });
    assert.equal(report.ok, true);
    assert.ok(report.rows.every((r) => r.ok));
  });
  it("a cloud-only scanner present => fail, names that id", () => {
    const leaked: ScannerDef[] = [
      { id: "trivy", bin: "trivy", args: [], format: "sarif" },
      { id: "snyk", bin: "snyk", args: [], format: "sarif", cloudOnly: true },
    ];
    const report = verifyAirGapScanners(leaked);
    assert.equal(report.ok, false);
    const snyk = report.rows.find((r) => r.id === "snyk")!;
    assert.equal(snyk.ok, false);
  });
  it("a registry semgrep config => fail, names semgrep", () => {
    const withSemgrep: ScannerDef[] = [
      { id: "semgrep", bin: "semgrep", args: [], format: "sarif", cloudOnly: true },
    ];
    const report = verifyAirGapScanners(withSemgrep, { semgrepConfig: "p/default" });
    assert.equal(report.ok, false);
    assert.ok(report.rows.find((r) => r.id === "semgrep" && !r.ok));
  });
});
