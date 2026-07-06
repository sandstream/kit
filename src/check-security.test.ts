import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import {
  checkSecurity,
  gateStatus,
  parseTrivyMisconfigCount,
  parseOsvVulnCount,
  parseTrivyVulnCount,
  classifyTrufflehogFindings,
  jvmProjectKind,
  findJvmProject,
  checkMemoryHooksLiveness,
  checkDeviceIdOverride,
  type SecurityCheckResult,
} from "./check-security.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("gateStatus — scanner-health strict by default", () => {
  const r = (over: Partial<SecurityCheckResult>): SecurityCheckResult => ({
    category: "supply-chain",
    name: "x",
    status: "warn",
    detail: "d",
    ...over,
  });
  it("passes pass/skip/fail through unchanged", () => {
    assert.equal(gateStatus(r({ status: "pass" })), "pass");
    assert.equal(gateStatus(r({ status: "skip" })), "skip");
    assert.equal(gateStatus(r({ status: "fail" })), "fail");
  });
  it("a didNotRun warn FAILS by default (green means it actually ran)", () => {
    assert.equal(gateStatus(r({ status: "warn", didNotRun: true })), "fail");
  });
  it("--lenient downgrades a didNotRun warn back to warn", () => {
    assert.equal(gateStatus(r({ status: "warn", didNotRun: true }), { lenient: true }), "warn");
  });
  it("a finding warn (ran + flagged) stays warn by default", () => {
    assert.equal(gateStatus(r({ status: "warn" })), "warn");
  });
  it("--fail-on-warning fails a finding warn too", () => {
    assert.equal(gateStatus(r({ status: "warn" }), { failOnWarning: true }), "fail");
  });
  it("didNotRun fails under fail-on-warning regardless of lenient=false", () => {
    assert.equal(
      gateStatus(r({ status: "warn", didNotRun: true }), { failOnWarning: true }),
      "fail",
    );
  });
});

describe("checkDeviceIdOverride (#79 — trust-bearing env override)", () => {
  const withEnv = async (
    deviceId: string | undefined,
    dbPath: string | undefined,
    fn: (r: SecurityCheckResult) => void,
  ) => {
    const prevD = process.env.KIT_DEVICE_ID;
    const prevDb = process.env.KIT_MEMORY_DB;
    try {
      if (deviceId === undefined) delete process.env.KIT_DEVICE_ID;
      else process.env.KIT_DEVICE_ID = deviceId;
      if (dbPath === undefined) delete process.env.KIT_MEMORY_DB;
      else process.env.KIT_MEMORY_DB = dbPath;
      fn(await checkDeviceIdOverride());
    } finally {
      if (prevD === undefined) delete process.env.KIT_DEVICE_ID;
      else process.env.KIT_DEVICE_ID = prevD;
      if (prevDb === undefined) delete process.env.KIT_MEMORY_DB;
      else process.env.KIT_MEMORY_DB = prevDb;
    }
  };

  it("skips when no override is set", async () => {
    await withEnv(undefined, undefined, (r) => assert.equal(r.status, "skip"));
  });

  it("skips when set but no store exists (no device fence in effect)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-devid-"));
    try {
      await withEnv("laptop-1", join(dir, "nope.db"), (r) => assert.equal(r.status, "skip"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("WARNs when a valid override is active on a real store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-devid-"));
    try {
      const dbPath = join(dir, "memory.db");
      writeFileSync(dbPath, ""); // existsSync is all the check needs
      await withEnv("laptop-1", dbPath, (r) => {
        assert.equal(r.status, "warn");
        assert.match(r.detail, /KIT_DEVICE_ID/);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkMemoryHooksLiveness (R5 — self-playing loop gate)", () => {
  const hookCmd = (sub: string) => ({
    hooks: [{ type: "command", command: `kit memory hook ${sub}` }],
  });
  const ALL_HOOKS = {
    hooks: {
      UserPromptSubmit: [hookCmd("user-prompt-submit")],
      SessionEnd: [hookCmd("session-end")],
      SessionStart: [hookCmd("session-start")],
    },
  };

  const withEnv = async (
    markerExists: boolean,
    settings: unknown,
    fn: (r: SecurityCheckResult) => void,
  ) => {
    const dir = mkdtempSync(join(tmpdir(), "kit-live-"));
    const prevM = process.env.KIT_MEMORY_HOOK_MARKER;
    const prevS = process.env.KIT_CLAUDE_SETTINGS;
    try {
      const marker = join(dir, "marker");
      if (markerExists) writeFileSync(marker, "2026-01-01T00:00:00Z\n");
      const settingsPath = join(dir, "settings.json");
      writeFileSync(settingsPath, JSON.stringify(settings));
      process.env.KIT_MEMORY_HOOK_MARKER = marker;
      process.env.KIT_CLAUDE_SETTINGS = settingsPath;
      fn(await checkMemoryHooksLiveness());
    } finally {
      if (prevM === undefined) delete process.env.KIT_MEMORY_HOOK_MARKER;
      else process.env.KIT_MEMORY_HOOK_MARKER = prevM;
      if (prevS === undefined) delete process.env.KIT_CLAUDE_SETTINGS;
      else process.env.KIT_CLAUDE_SETTINGS = prevS;
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("skips when never installed here (no marker → CI / fresh machine)", async () => {
    await withEnv(false, ALL_HOOKS, (r) => assert.equal(r.status, "skip"));
  });

  it("passes when installed and all capture hooks are still wired", async () => {
    await withEnv(true, ALL_HOOKS, (r) => assert.equal(r.status, "pass"));
  });

  it("FAILS when installed but a hook has vanished (capture silently off)", async () => {
    const missingOne = { hooks: { UserPromptSubmit: [hookCmd("user-prompt-submit")] } };
    await withEnv(true, missingOne, (r) => {
      assert.equal(r.status, "fail");
      assert.match(r.detail, /silently OFF/);
      assert.match(r.detail, /SessionEnd|SessionStart/);
    });
  });
});

describe("jvmProjectKind (#110)", () => {
  it("detects Maven and Gradle (incl. .kts), null otherwise", () => {
    assert.strictEqual(jvmProjectKind(["pom.xml"]), "maven");
    assert.strictEqual(jvmProjectKind(["build.gradle"]), "gradle");
    assert.strictEqual(jvmProjectKind(["build.gradle.kts"]), "gradle");
    assert.strictEqual(jvmProjectKind(["package.json", "README.md"]), null);
    // pom.xml wins when both present
    assert.strictEqual(jvmProjectKind(["pom.xml", "build.gradle"]), "maven");
  });
});

describe("findJvmProject (#110 — Gradle + nested depth)", () => {
  it("finds a Gradle project nested at depth 2", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-jvm-"));
    const deep = join(root, "services", "backend");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "build.gradle.kts"), "plugins {}\n");
    const found = await findJvmProject(root);
    assert.ok(found);
    assert.strictEqual(found!.kind, "gradle");
    assert.strictEqual(found!.dir, deep);
  });

  it("finds a Maven pom.xml at depth 2 (the monorepo layout #67 missed)", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-jvm-"));
    const deep = join(root, "apps", "api");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "pom.xml"), "<project/>\n");
    const found = await findJvmProject(root);
    assert.strictEqual(found?.kind, "maven");
  });

  it("returns null when there is no JVM project", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-jvm-"));
    writeFileSync(join(root, "package.json"), "{}\n");
    assert.strictEqual(await findJvmProject(root), null);
  });

  it("skips vendor dirs (node_modules) when searching", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-jvm-"));
    const buried = join(root, "node_modules", "x");
    mkdirSync(buried, { recursive: true });
    writeFileSync(join(buried, "pom.xml"), "<project/>\n");
    assert.strictEqual(await findJvmProject(root), null);
  });
});

describe("classifyTrufflehogFindings (verified vs unverified)", () => {
  const line = (det: string, verified: boolean) =>
    JSON.stringify({ DetectorName: det, Verified: verified });

  it("ignores the trufflehog info log line (no DetectorName)", () => {
    const out = classifyTrufflehogFindings('{"level":"info","msg":"starting"}\n');
    assert.deepStrictEqual(out, { verified: 0, unverified: 0 });
  });

  it("splits verified-live from unverified findings", () => {
    const stdout = [
      '{"level":"info"}',
      line("Postgres", false),
      line("Postgres", false),
      line("AWS", true),
    ].join("\n");
    assert.deepStrictEqual(classifyTrufflehogFindings(stdout), { verified: 1, unverified: 2 });
  });

  it("counts an unparseable DetectorName line conservatively as unverified", () => {
    const out = classifyTrufflehogFindings('{"DetectorName":"X" broken json');
    assert.deepStrictEqual(out, { verified: 0, unverified: 1 });
  });
});

describe("parseTrivyMisconfigCount", () => {
  it("counts only HIGH/CRITICAL misconfigurations", () => {
    const json = JSON.stringify({
      Results: [
        {
          Misconfigurations: [{ Severity: "HIGH" }, { Severity: "LOW" }, { Severity: "CRITICAL" }],
        },
        { Misconfigurations: [{ Severity: "MEDIUM" }] },
      ],
    });
    assert.strictEqual(parseTrivyMisconfigCount(json), 2);
  });

  it("returns 0 for a clean scan and -1 for unparseable output", () => {
    assert.strictEqual(parseTrivyMisconfigCount(JSON.stringify({ Results: [] })), 0);
    assert.strictEqual(parseTrivyMisconfigCount("not json"), -1);
  });
});

describe("parseTrivyVulnCount", () => {
  it("sums vulnerabilities across trivy fs results", () => {
    const json = JSON.stringify({
      Results: [
        { Target: "pom.xml", Vulnerabilities: [{ Severity: "HIGH" }, { Severity: "CRITICAL" }] },
        { Target: "pom.xml", Vulnerabilities: [{ Severity: "HIGH" }] },
        { Target: "novulns", Vulnerabilities: [] },
      ],
    });
    assert.strictEqual(parseTrivyVulnCount(json), 3);
  });

  it("returns 0 for a clean scan and -1 for unparseable output", () => {
    assert.strictEqual(parseTrivyVulnCount(JSON.stringify({ Results: [] })), 0);
    assert.strictEqual(parseTrivyVulnCount("not json"), -1);
  });
});

describe("parseOsvVulnCount", () => {
  it("sums vulnerabilities across results/packages", () => {
    const json = JSON.stringify({
      results: [
        { packages: [{ vulnerabilities: [{}, {}] }, { vulnerabilities: [{}] }] },
        { packages: [{ vulnerabilities: [] }] },
      ],
    });
    assert.strictEqual(parseOsvVulnCount(json), 3);
  });

  it("returns 0 for a clean scan and -1 for unparseable output", () => {
    assert.strictEqual(parseOsvVulnCount(JSON.stringify({ results: [] })), 0);
    assert.strictEqual(parseOsvVulnCount(""), -1);
  });
});

describe("checkSecurity", () => {
  // Bumblebee disabled so tests stay fast/offline (real scan downloads binary, walks machine).
  // Each test reuses a shared result set from a single checkSecurity() call to avoid
  // 5x cost on machines where ollama/etc are installed and respond slowly.
  let prevBumblebee: string | undefined;
  let cached: Awaited<ReturnType<typeof checkSecurity>>;

  before(async () => {
    prevBumblebee = process.env.KIT_BUMBLEBEE;
    process.env.KIT_BUMBLEBEE = "0";
    cached = await checkSecurity();
  });
  after(() => {
    if (prevBumblebee === undefined) delete process.env.KIT_BUMBLEBEE;
    else process.env.KIT_BUMBLEBEE = prevBumblebee;
  });

  it("returns an array of security check results", () => {
    assert.ok(Array.isArray(cached), "should return an array");
    assert.ok(cached.length > 0, "should have at least one check result");

    for (const result of cached) {
      assert.ok(result.category, "should have a category");
      assert.ok(result.name, "should have a name");
      assert.ok(result.status, "should have a status");
      assert.ok(result.detail, "should have a detail");
      assert.ok(
        ["pass", "fail", "warn", "skip"].includes(result.status),
        `status should be valid: ${result.status}`,
      );
    }
  });

  it("marks every tool-absent warn as didNotRun (scanner-health contract)", () => {
    // The module's contract: a check that could not RUN because its tool is absent
    // is `didNotRun` (fails the strict gate) — not a mere warning that slips through
    // as green. Environment-independent: where the tool IS installed the check turns
    // to pass (filtered out here); where it is absent it must carry didNotRun.
    const toolAbsentWarns = cached.filter(
      (r) => r.status === "warn" && /not installed|npx also unavailable/i.test(r.detail),
    );
    for (const r of toolAbsentWarns) {
      assert.strictEqual(
        r.didNotRun,
        true,
        `"${r.name}" (${r.detail}) is a tool-absent warn but is not marked didNotRun — it would pass the strict gate as a mere warning`,
      );
    }
  });

  it("includes npm audit check", () => {
    assert.ok(
      cached.find((r) => r.name === "npm audit"),
      "should include npm audit check",
    );
  });

  it("includes service exposure checks", () => {
    assert.ok(
      cached.find((r) => r.name === "Ollama"),
      "should include Ollama exposure check",
    );
    assert.ok(
      cached.find((r) => r.name === "Remote API"),
      "should include Remote API exposure check",
    );
  });

  it("includes supply chain checks", () => {
    assert.ok(
      cached.find((r) => r.name === "pinned versions"),
      "should include pinned versions check",
    );
  });

  it("includes secrets checks", () => {
    assert.ok(
      cached.find((r) => r.name === ".env gitignored"),
      "should include .env gitignored check",
    );
    assert.ok(
      cached.find((r) => r.name === "secrets scan"),
      "should include secrets scan check",
    );
  });
});
