import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import {
  basicSecretScanFiles,
  checkSecurity,
  gateStatus,
  parseTrivyMisconfigCount,
  parseOsvVulnCount,
  parseTrivyVulnCount,
  classifyTrufflehogFindings,
  isExampleCredential,
  jvmProjectKind,
  findJvmProject,
  checkMemoryHooksLiveness,
  checkMemoryInjection,
  checkGateLiveness,
  checkDeviceIdOverride,
  unpinnedNodeDeps,
  LOCKFILE_ECOSYSTEMS,
  type SecurityCheckResult,
} from "./check-security.js";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertMessage, openMemoryDb, upsertSession } from "./memory/db.js";

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
    const prevCodexM = process.env.KIT_CODEX_MEMORY_HOOK_MARKER;
    const prevCodexS = process.env.KIT_CODEX_HOOKS;
    try {
      const marker = join(dir, "marker");
      if (markerExists) writeFileSync(marker, "2026-01-01T00:00:00Z\n");
      const settingsPath = join(dir, "settings.json");
      writeFileSync(settingsPath, JSON.stringify(settings));
      process.env.KIT_MEMORY_HOOK_MARKER = marker;
      process.env.KIT_CLAUDE_SETTINGS = settingsPath;
      process.env.KIT_CODEX_MEMORY_HOOK_MARKER = join(dir, "no-codex-marker");
      process.env.KIT_CODEX_HOOKS = join(dir, "no-codex-hooks.json");
      fn(await checkMemoryHooksLiveness());
    } finally {
      if (prevM === undefined) delete process.env.KIT_MEMORY_HOOK_MARKER;
      else process.env.KIT_MEMORY_HOOK_MARKER = prevM;
      if (prevS === undefined) delete process.env.KIT_CLAUDE_SETTINGS;
      else process.env.KIT_CLAUDE_SETTINGS = prevS;
      if (prevCodexM === undefined) delete process.env.KIT_CODEX_MEMORY_HOOK_MARKER;
      else process.env.KIT_CODEX_MEMORY_HOOK_MARKER = prevCodexM;
      if (prevCodexS === undefined) delete process.env.KIT_CODEX_HOOKS;
      else process.env.KIT_CODEX_HOOKS = prevCodexS;
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

  it("FAILS when Codex was installed but its lifecycle config was stripped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-live-codex-"));
    const previous = {
      claudeMarker: process.env.KIT_MEMORY_HOOK_MARKER,
      claudeSettings: process.env.KIT_CLAUDE_SETTINGS,
      codexMarker: process.env.KIT_CODEX_MEMORY_HOOK_MARKER,
      codexHooks: process.env.KIT_CODEX_HOOKS,
    };
    try {
      process.env.KIT_MEMORY_HOOK_MARKER = join(dir, "no-claude-marker");
      process.env.KIT_CLAUDE_SETTINGS = join(dir, "no-claude-settings.json");
      process.env.KIT_CODEX_MEMORY_HOOK_MARKER = join(dir, "codex-marker");
      process.env.KIT_CODEX_HOOKS = join(dir, "codex-hooks.json");
      writeFileSync(process.env.KIT_CODEX_MEMORY_HOOK_MARKER, "installed\n");
      writeFileSync(process.env.KIT_CODEX_HOOKS, "{}\n");

      const result = await checkMemoryHooksLiveness();
      assert.equal(result.status, "fail");
      assert.match(result.detail, /Codex:SessionEnd/);
    } finally {
      const restore = (key: string, value: string | undefined) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      };
      restore("KIT_MEMORY_HOOK_MARKER", previous.claudeMarker);
      restore("KIT_CLAUDE_SETTINGS", previous.claudeSettings);
      restore("KIT_CODEX_MEMORY_HOOK_MARKER", previous.codexMarker);
      restore("KIT_CODEX_HOOKS", previous.codexHooks);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkMemoryInjection", () => {
  it("scans read-only when WAL sidecars cannot be created", async () => {
    if (process.platform === "win32") return;

    const dir = mkdtempSync(join(tmpdir(), "kit-memory-security-"));
    const dbPath = join(dir, "memory.db");
    const prevDb = process.env.KIT_MEMORY_DB;
    try {
      const db = openMemoryDb(dbPath);
      upsertSession(db, { sessionId: "s1", harness: "codex" });
      insertMessage(db, {
        uuid: "m1",
        sessionId: "s1",
        type: "user",
        content: "ordinary note",
      });
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      chmodSync(dir, 0o500);

      process.env.KIT_MEMORY_DB = dbPath;
      const result = await checkMemoryInjection();

      assert.equal(result.status, "pass");
      assert.equal(statSync(dir).mode & 0o777, 0o500);
      assert.equal(existsSync(`${dbPath}-wal`), false);
      assert.equal(existsSync(`${dbPath}-shm`), false);
    } finally {
      if (prevDb === undefined) delete process.env.KIT_MEMORY_DB;
      else process.env.KIT_MEMORY_DB = prevDb;
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkGateLiveness", () => {
  it("FAILS when Codex hook config points at a stale root wrapper path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-live-codex-gate-"));
    try {
      mkdirSync(join(dir, ".codex"), { recursive: true });
      writeFileSync(
        join(dir, ".codex", "config.toml"),
        '[[hooks.PreToolUse]]\nmatcher = "^Bash$"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = \'/root/.kit/bin/kit gate-bash\'\n',
      );

      const result = await checkGateLiveness(dir);
      assert.equal(result.status, "fail");
      assert.match(result.detail, /root\/container path/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe("classifyTrufflehogFindings (verified vs unverified vs public-by-design)", () => {
  const line = (det: string, verified: boolean) =>
    JSON.stringify({ DetectorName: det, Verified: verified });

  it("ignores the trufflehog info log line (no DetectorName)", () => {
    const out = classifyTrufflehogFindings('{"level":"info","msg":"starting"}\n');
    assert.deepStrictEqual(out, { verified: 0, unverified: 0, publicByDesign: 0, example: 0 });
  });

  it("splits verified-live from unverified findings", () => {
    const stdout = [
      '{"level":"info"}',
      line("Postgres", false),
      line("Postgres", false),
      line("AWS", true),
    ].join("\n");
    assert.deepStrictEqual(classifyTrufflehogFindings(stdout), {
      verified: 1,
      unverified: 2,
      publicByDesign: 0,
      example: 0,
    });
  });

  it("counts an unparseable DetectorName line conservatively as unverified", () => {
    const out = classifyTrufflehogFindings('{"DetectorName":"X" broken json');
    assert.deepStrictEqual(out, { verified: 0, unverified: 1, publicByDesign: 0, example: 0 });
  });
});

describe("example credentials (test fixtures / docs placeholders)", () => {
  const uri = (raw: string, verified = false) =>
    JSON.stringify({ DetectorName: "Postgres", Verified: verified, Raw: raw });

  it("treats an unreachable host as an example credential", () => {
    // Unqualified single-label hosts (compose/k8s service names), loopback, and the
    // reserved dev suffixes cannot name a service on the public internet.
    for (const raw of [
      "postgres://user:supersecret@host:5432",
      "postgres://app:S3cr3tPassw0rd@db:5432",
      "postgresql://kit:password@postgres:5432",
      "postgres://app:S3cr3tPassw0rd@db.internal:5432",
      "postgresql://admin:hunter2@cache.local:6379",
      "postgres://u:p@localhost:5432",
      "postgresql://u:p@127.0.0.1:5432",
      "postgres://svc:t0ps3cret@db.example.com:5432",
    ]) {
      assert.strictEqual(isExampleCredential({ verified: false, raw }), true, raw);
    }
  });

  it("treats a placeholder password on a real host as an example credential", () => {
    for (const raw of [
      "postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech:5432",
      "postgresql://user:password@db.acme-prod.io:5432",
      "postgres://user:changeme@db.acme-prod.io:5432",
    ]) {
      assert.strictEqual(isExampleCredential({ verified: false, raw }), true, raw);
    }
  });

  it("recognises GitHub's own documentation sample token", () => {
    assert.strictEqual(
      isExampleCredential({
        verified: false,
        raw: "ghp_16C7e42F292c6912E7710c838347Ae178B4a1234",
      }),
      true,
    );
  });

  it("leaves a real-looking credential on a routable host as a finding to review", () => {
    for (const raw of [
      "postgresql://svc_api:8Fh2kdlsPQzR@db.acme-prod.io:5432",
      "postgres://reporting:Xk29fjMs01@10.4.2.9:5432", // routable-shaped IP, real-shaped secret
      "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
    ]) {
      assert.strictEqual(isExampleCredential({ verified: false, raw }), false, raw);
    }
  });

  it("never waves through a VERIFIED-LIVE credential, however placeholder-shaped", () => {
    const raw = "postgresql://user:pass@host:5432";
    assert.strictEqual(isExampleCredential({ verified: true, raw }), false);
    assert.deepStrictEqual(classifyTrufflehogFindings(uri(raw, true)), {
      verified: 1,
      unverified: 0,
      publicByDesign: 0,
      example: 0,
    });
  });

  it("counts example credentials in their own bucket, not as unverified", () => {
    const stdout = [
      uri("postgresql://user:pass@host:5432"),
      uri("postgres://app:S3cr3tPassw0rd@db.internal:5432"),
      uri("postgresql://svc_api:8Fh2kdlsPQzR@db.acme-prod.io:5432"),
    ].join("\n");
    assert.deepStrictEqual(classifyTrufflehogFindings(stdout), {
      verified: 0,
      unverified: 1,
      publicByDesign: 0,
      example: 2,
    });
  });
});

describe("public-by-design client keys (#250)", () => {
  const AIZA = "AIza" + "A".repeat(35);
  const fbLine = JSON.stringify({
    DetectorName: "GoogleApiKey",
    Verified: false,
    Raw: AIZA,
    SourceMetadata: { Data: { Git: { file: "src/firebase.ts" } } },
  });
  const fbConfig = `export const firebaseConfig = { apiKey: "${AIZA}", authDomain: "x.firebaseapp.com", projectId: "x" }`;

  it("Firebase web config = public-by-design ONLY with co-occurring config context", () => {
    const withContext = classifyTrufflehogFindings(fbLine, () => fbConfig);
    assert.deepStrictEqual(withContext, {
      verified: 0,
      unverified: 0,
      publicByDesign: 1,
      example: 0,
    });
    // Same AIza key WITHOUT Firebase context could be a privileged server key —
    // stays a normal unverified finding.
    const without = classifyTrufflehogFindings(fbLine, () => `const key = "${AIZA}"`);
    assert.deepStrictEqual(without, { verified: 0, unverified: 1, publicByDesign: 0, example: 0 });
    // Unreadable/deleted file ⇒ never downgrade on missing evidence.
    const unreadable = classifyTrufflehogFindings(fbLine, () => null);
    assert.deepStrictEqual(unreadable, {
      verified: 0,
      unverified: 1,
      publicByDesign: 0,
      example: 0,
    });
  });

  it("a VERIFIED-LIVE AIza key is never waved through as public-by-design", () => {
    const liveLine = JSON.stringify({
      DetectorName: "GoogleApiKey",
      Verified: true,
      Raw: AIZA,
      SourceMetadata: { Data: { Git: { file: "src/firebase.ts" } } },
    });
    const out = classifyTrufflehogFindings(liveLine, () => fbConfig);
    assert.deepStrictEqual(out, { verified: 1, unverified: 0, publicByDesign: 0, example: 0 });
  });

  it("Sentry DSN and PostHog project keys are public-by-design by shape alone", () => {
    const dsn = JSON.stringify({
      DetectorName: "SentryDSN",
      Verified: false,
      Raw: "https://abcdef0123456789@o123.ingest.sentry.io/456",
    });
    const phc = JSON.stringify({
      DetectorName: "Generic",
      Verified: false,
      Raw: "phc_" + "a".repeat(43),
    });
    const out = classifyTrufflehogFindings([dsn, phc].join("\n"), () => null);
    assert.deepStrictEqual(out, { verified: 0, unverified: 0, publicByDesign: 2, example: 0 });
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
  const envKeys = [
    "KIT_AUDIT_ANCHOR",
    "KIT_BUMBLEBEE",
    "KIT_CLAUDE_SETTINGS",
    "KIT_CODEX_HOOKS",
    "KIT_CODEX_MEMORY_HOOK_MARKER",
    "KIT_GUARDDOG",
    "KIT_MEMORY_DB",
    "KIT_MEMORY_DIR",
    "KIT_MEMORY_HOOK_MARKER",
    "KIT_NO_DOWNLOAD",
    "KIT_SEMGREP_CONFIG",
  ] as const;
  const prevEnv = new Map<string, string | undefined>();
  let root: string;
  let cached: Awaited<ReturnType<typeof checkSecurity>>;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "kit-security-"));
    const agentState = join(root, ".kit-test-agent-state");
    mkdirSync(agentState, { recursive: true });
    writeFileSync(
      join(root, ".gitignore"),
      [".env", ".env.local", ".env.*.local", "node_modules"].join("\n") + "\n",
    );
    for (const key of envKeys) prevEnv.set(key, process.env[key]);
    process.env.KIT_AUDIT_ANCHOR = "0";
    process.env.KIT_BUMBLEBEE = "0";
    process.env.KIT_CLAUDE_SETTINGS = join(agentState, "claude-settings.json");
    process.env.KIT_CODEX_HOOKS = join(agentState, "codex-hooks.json");
    process.env.KIT_CODEX_MEMORY_HOOK_MARKER = join(agentState, "codex-marker");
    process.env.KIT_GUARDDOG = "0";
    process.env.KIT_MEMORY_DB = join(agentState, "memory.db");
    process.env.KIT_MEMORY_DIR = agentState;
    process.env.KIT_MEMORY_HOOK_MARKER = join(agentState, "claude-marker");
    process.env.KIT_NO_DOWNLOAD = "1";
    delete process.env.KIT_SEMGREP_CONFIG;
    cached = await checkSecurity(root);
  });
  after(() => {
    for (const key of envKeys) {
      const value = prevEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
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

describe("basicSecretScanFiles — degraded-path false-positive filter", () => {
  const hit = (file: string, content: string) => `${file}:12:${content}`;

  it("flags a literal secret-shaped value outside tests", () => {
    const files = basicSecretScanFiles([
      hit("src/config.ts", `const apiKey = "literal-looking-value-0123456789abcdef"`),
    ]);
    assert.deepStrictEqual(files, ["src/config.ts"]);
  });

  it("skips test/fixture/mock paths", () => {
    const files = basicSecretScanFiles([
      hit("src/auth.test.ts", `password = "hunter2hunter2hunter2hunter2"`),
      hit("src/__mocks__/api.ts", `token = "aaaaaaaaaaaaaaaaaaaaaaaaaaaa"`),
      hit("test/fixtures/creds.json", `"api_key": "bbbbbbbbbbbbbbbbbbbbbbbb"`),
    ]);
    assert.deepStrictEqual(files, []);
  });

  it("skips all-caps env-var NAMES used as values", () => {
    const files = basicSecretScanFiles([
      hit("src/env.ts", `token = "SOCKET_SECURITY_API_TOKEN_LONG"`),
    ]);
    assert.deepStrictEqual(files, []);
  });

  it("skips pure substitution expressions (Actions / shell / Helm) — the curl case", () => {
    const files = basicSecretScanFiles([
      hit(".github/workflows/ci.yml", `GH_TOKEN: '${"$"}{{ secrets.GITHUB_TOKEN }}'`),
      hit("docker-compose.yml", `password: '${"$"}{POSTGRES_PASSWORD_FROM_ENV}'`),
      hit("chart/values.yaml", `apiKey: '{{ .Values.global.apiKeySecretRef }}'`),
      hit("docs/contributing.md", `PYTEST_OPENAI_API_KEY="$(llm keys get openai)"`),
    ]);
    assert.deepStrictEqual(files, []);
  });

  it("still flags a template-PREFIXED literal (not a pure expression)", () => {
    const files = basicSecretScanFiles([
      hit("src/leak.ts", `token = "${"$"}{{ secrets.X }}-plus-a-literal-suffix"`),
    ]);
    assert.deepStrictEqual(files, ["src/leak.ts"]);
  });

  it("dedupes multiple hits in one file and ignores malformed grep lines", () => {
    const files = basicSecretScanFiles([
      hit("src/a.ts", `password = "cccccccccccccccccccccccc"`),
      hit("src/a.ts", `api_key = "dddddddddddddddddddddddd"`),
      "not-a-grep-line",
    ]);
    assert.deepStrictEqual(files, ["src/a.ts"]);
  });
});

describe("lockfile ecosystem coverage (#353)", () => {
  const byName = Object.fromEntries(LOCKFILE_ECOSYSTEMS.map((e) => [e.name, e]));

  it("npm/node accepts any JS lockfile, not just package-lock.json", () => {
    const npm = byName["package-lock.json"];
    for (const lf of [
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "bun.lockb",
      "bun.lock",
    ]) {
      assert.ok(npm.lockfiles.includes(lf), `npm ecosystem should accept ${lf}`);
    }
  });

  it("covers the non-npm/pip ecosystems that used to false-fail", () => {
    for (const name of [
      "Cargo.lock",
      "go.sum",
      "Gemfile.lock",
      "composer.lock",
      "pubspec.lock",
      "Package.resolved",
      "mix.lock",
      "flake.lock",
    ]) {
      assert.ok(byName[name], `missing ecosystem: ${name}`);
    }
  });

  it("does NOT flag opt-in-lockfile ecosystems (Gradle/Maven/.NET) — no new false-red", () => {
    // Their lockfiles are opt-in; a missing one is not a finding. Absence from the
    // map is intentional (JVM/.NET vulns are covered by trivy/osv instead).
    for (const m of ["pom.xml", "build.gradle", "packages.lock.json"]) {
      assert.ok(
        !LOCKFILE_ECOSYSTEMS.some((e) => e.manifests.includes(m)),
        `${m} should not gate the committed-lockfile check`,
      );
    }
  });

  it("python accepts poetry/pipenv/uv locks, not just requirements.txt", () => {
    const py = byName["requirements.txt"];
    for (const lf of ["requirements.txt", "poetry.lock", "Pipfile.lock", "uv.lock"]) {
      assert.ok(py.lockfiles.includes(lf), `python ecosystem should accept ${lf}`);
    }
  });

  it("every ecosystem lists at least one manifest and one lockfile", () => {
    for (const e of LOCKFILE_ECOSYSTEMS) {
      assert.ok(e.manifests.length > 0 && e.lockfiles.length > 0, `${e.name} malformed`);
    }
  });
});

// Workspace-aware pinning: internal monorepo packages resolve to the local
// tree, never the registry — "@repo/x": "*" is npm-workspaces convention, not
// a floating range, and "pinning" it would actually be wrong (real false
// positive from a Turborepo user).
describe("unpinnedNodeDeps", () => {
  const noMembers = () => false;

  it("flags registry ranges and floating versions", () => {
    assert.deepStrictEqual(
      unpinnedNodeDeps({ a: "^1.2.3", b: "~2.0.0", c: ">=3", d: "*", e: "4.x" }, noMembers),
      ["a@^1.2.3", "b@~2.0.0", "c@>=3", "d@*", "e@4.x"],
    );
  });

  it("passes exact versions", () => {
    assert.deepStrictEqual(unpinnedNodeDeps({ a: "1.2.3", b: "0.0.1-rc.2" }, noMembers), []);
  });

  it("skips workspace/file/link/portal/catalog protocol refs — local, not floating", () => {
    assert.deepStrictEqual(
      unpinnedNodeDeps(
        {
          a: "workspace:*",
          b: "workspace:^",
          c: "file:../local",
          d: "link:../local",
          e: "portal:../local",
          f: "catalog:default",
        },
        noMembers,
      ),
      [],
    );
  });

  it('skips "*" on internal workspace members but still flags external "*"', () => {
    const members = new Set(["@repo/ui", "@repo/config"]);
    assert.deepStrictEqual(
      unpinnedNodeDeps({ "@repo/ui": "*", "@repo/config": "*", "left-pad": "*" }, (n) =>
        members.has(n),
      ),
      ["left-pad@*"],
    );
  });

  it("handles a missing dep map", () => {
    assert.deepStrictEqual(unpinnedNodeDeps(undefined, noMembers), []);
  });
});
