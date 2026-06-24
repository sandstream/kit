import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import {
  checkSecurity,
  parseTrivyMisconfigCount,
  parseOsvVulnCount,
  parseTrivyVulnCount,
  classifySocketResult,
  classifyTrufflehogFindings,
} from "./check-security.js";

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

describe("classifySocketResult (fail-closed)", () => {
  it("never passes when Socket is not logged in (the false-green guard)", () => {
    for (const raw of [
      "Please run `socket login` first",
      "Error: unauthenticated",
      "401 Unauthorized",
      "Set SOCKET_API_TOKEN to continue",
    ]) {
      const r = classifySocketResult(raw, false);
      assert.strictEqual(r.status, "warn", `expected warn for: ${raw}`);
      assert.match(r.detail, /UNVERIFIED|not logged in/);
      assert.strictEqual(r.suggestion, "socket login");
    }
  });

  it("passes ONLY on a valid scan result with zero issues", () => {
    const r = classifySocketResult(JSON.stringify({ issues: [] }), true);
    assert.strictEqual(r.status, "pass");
  });

  it("fails on critical/high issues, warns on lower issues", () => {
    assert.strictEqual(
      classifySocketResult(JSON.stringify({ issues: [{ severity: "critical" }] }), false).status,
      "fail",
    );
    assert.strictEqual(
      classifySocketResult(JSON.stringify({ issues: [{ severity: "low" }] }), true).status,
      "warn",
    );
  });

  it("does NOT pass on unparseable output, even with exit 0 (no proof of scan)", () => {
    const r = classifySocketResult("some human-readable banner, not JSON", true);
    assert.strictEqual(r.status, "warn");
    assert.match(r.detail, /UNVERIFIED/);
  });

  it("warns (not pass) on non-zero exit with no parseable output", () => {
    const r = classifySocketResult("", false);
    assert.strictEqual(r.status, "warn");
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
