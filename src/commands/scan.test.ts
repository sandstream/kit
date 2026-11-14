/**
 * Characterization tests for `kit scan` (cmdScan). They pin the command's observable behavior
 * before the function is split into helpers: flags, air-gap fail-closed paths, tooling tokens,
 * the baseline, and the three output modes.
 *
 * The CLI runs with a PATH that holds only fake tools, so no real scanner, `mise` or `infisical`
 * on the machine changes the result. `which` is a fake too: it names only the fakes that exist.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign as cryptoSign, createHash } from "node:crypto";
import { runCli, type CliResult } from "../cli-run.test-support.js";
import { rmTemp } from "../temp-cleanup.test-support.js";

// Fake tools are POSIX shell scripts, and Windows cannot run them from execFile.
const skip = process.platform === "win32" ? "fake tools are /bin/sh scripts (POSIX only)" : false;

const ANSI = /\x1b\[[0-9;]*m/g;
const plain = (s: string) => s.replace(ANSI, "");

const EMPTY_SARIF = JSON.stringify({
  version: "2.1.0",
  runs: [{ tool: { driver: { name: "grype", rules: [] } }, results: [] }],
});

interface Fixture {
  dir: string;
  bin: string;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "kit-scan-char-"));
  const bin = join(dir, ".fakebin");
  mkdirSync(bin);
  writeFileSync(join(dir, "package.json"), '{"name":"t","dependencies":{}}');
  // `which <tool>` prints the fake's path when a fake exists, else exits 1 (not installed).
  tool(
    { dir, bin },
    "which",
    `[ -x "${bin}/$1" ] && [ "$1" != which ] && { echo "${bin}/$1"; exit 0; }\nexit 1`,
  );
  return { dir, bin };
}

function tool(f: Fixture, name: string, body: string): void {
  const p = join(f.bin, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
}

function toml(f: Fixture, text: string): void {
  writeFileSync(join(f.dir, ".kit.toml"), text);
}

function scan(f: Fixture, args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  return runCli(["scan", ...args], f.dir, {
    PATH: f.bin,
    SOCKET_SECURITY_API_TOKEN: "",
    SNYK_TOKEN: "",
    KIT_SEMGREP_CONFIG: "",
    KIT_AIRGAP: "",
    KIT_CI_STRICT: "",
    KIT_THREAT_DATA_DIR: "",
    KIT_THREAT_DATA_PUBKEY: "",
    ...env,
  });
}

/** A signed threat-data bundle with one artifact that sets env KIT_TD_PROBE. */
function makeBundle(f: Fixture): { dir: string; pubPath: string } {
  const dir = join(f.dir, ".td");
  mkdirSync(dir);
  const bytes = "db";
  writeFileSync(join(dir, "db.bin"), bytes);
  const manifest = {
    version: 1,
    created: "2026-11-10T00:00:00.000Z",
    artifacts: [
      {
        path: "db.bin",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        env: "KIT_TD_PROBE",
      },
    ],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, "manifest.json"), manifestBytes);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(
    join(dir, "manifest.json.sig"),
    cryptoSign(null, manifestBytes, privateKey).toString("base64"),
  );
  const pubPath = join(f.dir, ".td.pub");
  writeFileSync(pubPath, publicKey.export({ type: "spki", format: "pem" }) as string);
  return { dir, pubPath };
}

// One fixture per test. Each describe block calls useFixture(), so the blocks stay short.
let f: Fixture;
function useFixture(): void {
  beforeEach(() => {
    f = makeFixture();
  });
  afterEach(async () => {
    await rmTemp(f.dir);
  });
}

describe("kit scan: delegates and output modes", { skip }, () => {
  useFixture();

  it("--list-delegates prints every scanner with its on/off state and exits 0", async () => {
    toml(f, '[scan]\ndelegates = ["socket", "grype"]\n');
    const r = await scan(f, ["--list-delegates"]);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(
      plain(r.stdout),
      [
        "off snyk          sarif  (needs SNYK_TOKEN, cloud-only)",
        "off trivy         sarif",
        "off trivy-config  sarif",
        "on  grype         sarif",
        "off semgrep       sarif  (needs KIT_SEMGREP_CONFIG, cloud-only)",
        "off osv-scanner   osv",
        "on  socket        sarif  (needs SOCKET_SECURITY_API_TOKEN, cloud-only)",
        "",
      ].join("\n"),
    );
  });

  it("text mode: a failing exit-gate scanner is one high finding and exit 1", async () => {
    toml(f, '[scan]\ndelegates = ["socket"]\n');
    tool(f, "socket", "exit 1");
    const r = await scan(f, [], { SOCKET_SECURITY_API_TOKEN: "t" });
    assert.equal(r.exitCode, 1, r.stdout + r.stderr);
    const out = plain(r.stdout);
    assert.match(out, /^kit scan {2}external scanners → one merged verdict\n/);
    assert.match(out, /\n {2}✓ socket {2}1 finding\(s\)\n/);
    assert.match(out, /\n {2}HIGH {5}socket: [^\n]+ {2}\[socket\]\n/);
    assert.match(out, /\n1 high\/critical\n$/);
  });

  it("text mode: no findings and a not-installed scanner warn without failing", async () => {
    toml(f, '[scan]\ndelegates = ["socket", "grype"]\n');
    tool(f, "socket", "exit 0");
    const r = await scan(f, [], { SOCKET_SECURITY_API_TOKEN: "t" });
    assert.equal(r.exitCode, 0, r.stdout + r.stderr);
    const out = plain(r.stdout);
    assert.match(out, /\n {2}− grype {2}not-installed[^\n]*\n/);
    assert.match(out, /\n {2}✓ socket {2}0 finding\(s\)\n/);
    assert.match(out, /\n {2}no findings from the scanners that ran\n/);
    assert.match(out, /\n {2}! [^\n]*grype[^\n]*\n/);
    assert.match(out, /use --strict or \[governance\.scan\] required_scanners to hard-fail/);
  });
});

describe("kit scan: scanner-health gate", { skip }, () => {
  useFixture();

  it("--strict turns a not-installed scanner into a failure", async () => {
    toml(f, '[scan]\ndelegates = ["socket", "grype"]\n');
    tool(f, "socket", "exit 0");
    const r = await scan(f, ["--strict"], { SOCKET_SECURITY_API_TOKEN: "t" });
    assert.equal(r.exitCode, 1, r.stdout + r.stderr);
    assert.match(plain(r.stdout), /\n {2}✗ [^\n]*grype[^\n]*\n/);
    assert.doesNotMatch(plain(r.stdout), /hard-fail/);
  });

  it("KIT_CI_STRICT and [governance.scan] required_scanners also fail the gate", async () => {
    tool(f, "socket", "exit 0");
    toml(f, '[scan]\ndelegates = ["socket", "grype"]\n');
    const viaEnv = await scan(f, [], { SOCKET_SECURITY_API_TOKEN: "t", KIT_CI_STRICT: "1" });
    assert.equal(viaEnv.exitCode, 1, viaEnv.stdout);
    toml(
      f,
      '[scan]\ndelegates = ["socket", "grype"]\n[governance.scan]\nrequired_scanners = ["grype"]\n',
    );
    const viaCfg = await scan(f, [], { SOCKET_SECURITY_API_TOKEN: "t" });
    assert.equal(viaCfg.exitCode, 1, viaCfg.stdout);
  });

  it("--json prints runs, findings, suppressed, ok, scannerGate and strict", async () => {
    toml(f, '[scan]\ndelegates = ["socket"]\n');
    tool(f, "socket", "exit 1");
    const r = await scan(f, ["--json"], { SOCKET_SECURITY_API_TOKEN: "t" });
    assert.equal(r.exitCode, 1, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(j), [
      "runs",
      "findings",
      "suppressed",
      "ok",
      "scannerGate",
      "strict",
    ]);
    assert.deepEqual(j.runs, [{ id: "socket", status: "ran", findings: 1 }]);
    assert.equal(j.findings.length, 1);
    assert.equal(j.findings[0].severity, "high");
    assert.equal(j.suppressed, 0);
    assert.equal(j.ok, false);
    assert.equal(j.scannerGate.ok, true);
    assert.equal(j.strict, false);
  });

  it("--sarif prints a SARIF log of the findings and keeps the exit code", async () => {
    toml(f, '[scan]\ndelegates = ["socket"]\n');
    tool(f, "socket", "exit 1");
    const r = await scan(f, ["--sarif", "--json"], { SOCKET_SECURITY_API_TOKEN: "t" });
    assert.equal(r.exitCode, 1, r.stderr);
    const s = JSON.parse(r.stdout);
    assert.equal(s.version, "2.1.0");
    assert.equal(s.runs[0].results.length, 1);
  });
});

describe("kit scan: baseline and tooling tokens", { skip }, () => {
  useFixture();

  it("--update-baseline accepts the findings; the next run suppresses them and passes", async () => {
    toml(f, '[scan]\ndelegates = ["socket"]\n');
    tool(f, "socket", "exit 1");
    const env = { SOCKET_SECURITY_API_TOKEN: "t" };
    const up = await scan(f, ["--update-baseline"], env);
    assert.equal(up.exitCode, 0, up.stderr);
    assert.match(
      plain(up.stdout),
      /^baseline updated {2}1 scan finding\(s\) accepted into \.kit-baseline\.json\n$/,
    );
    const bl = JSON.parse(readFileSync(join(f.dir, ".kit-baseline.json"), "utf8"));
    assert.equal(JSON.stringify(bl).includes("socket"), true);

    const r = await scan(f, [], env);
    assert.equal(r.exitCode, 0, r.stdout);
    const out = plain(r.stdout);
    assert.match(out, /^kit scan {2}external scanners → one merged verdict {2}\(1 baselined\)\n/);
    assert.match(out, /\n {2}no findings \(after baseline\)\n/);
    const j = JSON.parse((await scan(f, ["--json"], env)).stdout);
    assert.equal(j.suppressed, 1);
    assert.equal(j.ok, true);
  });

  it("a tooling Infisical project supplies a missing scanner token to the scanner only", async () => {
    toml(f, '[scan]\ndelegates = ["socket"]\n[scan.tooling]\nproject_id = "p1"\nenv = "prod"\n');
    tool(
      f,
      "infisical",
      `echo "$@" > "${f.dir}/infisical-args"\necho '[{"key":"SOCKET_SECURITY_API_TOKEN","value":"from-vault"}]'`,
    );
    tool(f, "socket", '[ "$SOCKET_SECURITY_API_TOKEN" = from-vault ] && exit 0\nexit 1');
    const r = await scan(f, ["--json"]);
    assert.equal(r.exitCode, 0, r.stdout + r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).runs, [{ id: "socket", status: "ran", findings: 0 }]);
    assert.match(readFileSync(join(f.dir, "infisical-args"), "utf8"), /--env prod --projectId p1/);
    assert.equal(r.stdout.includes("from-vault"), false);
  });

  it("without a tooling project, a missing token is no-token", async () => {
    toml(f, '[scan]\ndelegates = ["socket"]\n');
    tool(f, "socket", "exit 0");
    const j = JSON.parse((await scan(f, ["--json"])).stdout);
    assert.deepEqual(j.runs, [{ id: "socket", status: "no-token", findings: 0 }]);
  });
});

describe("kit scan: air-gap", { skip }, () => {
  useFixture();

  it("air-gap drops cloud-only scanners and names them", async () => {
    toml(f, '[scan]\ndelegates = ["socket", "grype"]\n');
    tool(f, "grype", `echo '${EMPTY_SARIF}'`);
    const r = await scan(f, [], { KIT_AIRGAP: "1", SOCKET_SECURITY_API_TOKEN: "t" });
    assert.equal(r.exitCode, 0, r.stdout + r.stderr);
    const out = plain(r.stdout);
    assert.match(out, /^air-gap mode: offline scanners only \(skipping cloud-only: socket\)\n/);
    assert.match(out, /\n {2}✓ grype {2}0 finding\(s\)\n/);
    assert.doesNotMatch(out, /socket {2}/);
  });

  it("air-gap warns that a registry KIT_SEMGREP_CONFIG is not run", async () => {
    toml(f, '[scan]\ndelegates = ["grype"]\n');
    tool(f, "grype", `echo '${EMPTY_SARIF}'`);
    const r = await scan(f, [], { KIT_AIRGAP: "1", KIT_SEMGREP_CONFIG: "p/default" });
    assert.equal(r.exitCode, 0, r.stdout + r.stderr);
    assert.match(
      plain(r.stderr),
      /! air-gap: KIT_SEMGREP_CONFIG='p\/default' is a registry config [^\n]*semgrep is NOT run air-gapped/,
    );
  });
});

describe("kit scan: air-gap threat data", { skip }, () => {
  useFixture();

  it("air-gap with a threat-data dir and no public key fails closed before any scanner", async () => {
    toml(f, '[scan]\ndelegates = ["grype"]\n');
    tool(f, "grype", `touch "${f.dir}/grype-ran"\necho '${EMPTY_SARIF}'`);
    const r = await scan(f, [], { KIT_AIRGAP: "1", KIT_THREAT_DATA_DIR: join(f.dir, "td") });
    assert.equal(r.exitCode, 1);
    assert.match(
      plain(r.stderr),
      /✗ air-gap threat-data dir set but no public key [^\n]*\(fail-closed\)/,
    );
    assert.equal(existsSync(join(f.dir, "grype-ran")), false);
  });

  it("air-gap rejects a threat-data bundle that does not verify, before any scanner", async () => {
    toml(f, '[scan]\ndelegates = ["grype"]\n');
    tool(f, "grype", `touch "${f.dir}/grype-ran"\necho '${EMPTY_SARIF}'`);
    const b = makeBundle(f);
    writeFileSync(join(b.dir, "db.bin"), "tampered");
    const r = await scan(f, [], {
      KIT_AIRGAP: "1",
      KIT_THREAT_DATA_DIR: b.dir,
      KIT_THREAT_DATA_PUBKEY: b.pubPath,
    });
    assert.equal(r.exitCode, 1);
    assert.match(plain(r.stderr), /✗ threat-data bundle rejected: [^\n]+ \(fail-closed\)/);
    assert.equal(existsSync(join(f.dir, "grype-ran")), false);
  });

  it("air-gap with a verified bundle passes its env to the scanners", async () => {
    toml(f, '[scan]\ndelegates = ["grype"]\n');
    tool(f, "grype", `echo "$KIT_TD_PROBE" > "${f.dir}/probe"\necho '${EMPTY_SARIF}'`);
    const b = makeBundle(f);
    const r = await scan(f, [], {
      KIT_AIRGAP: "1",
      KIT_THREAT_DATA_DIR: b.dir,
      KIT_THREAT_DATA_PUBKEY: b.pubPath,
    });
    assert.equal(r.exitCode, 0, r.stdout + r.stderr);
    assert.match(
      plain(r.stdout),
      /\nverified threat-data bundle: 1 artifact\(s\) signed \+ checksummed\n/,
    );
    assert.equal(readFileSync(join(f.dir, "probe"), "utf8").trim(), join(b.dir, "db.bin"));
  });
});

describe("kit scan: projects, images and severities", { skip }, () => {
  useFixture();

  it("a [projects] path that does not exist is refused with a warning", async () => {
    toml(f, '[scan]\ndelegates = ["socket"]\n[projects]\npaths = ["missing"]\n');
    tool(f, "socket", "exit 0");
    const r = await scan(f, [], { SOCKET_SECURITY_API_TOKEN: "t" });
    assert.equal(r.exitCode, 0, r.stdout + r.stderr);
    assert.match(plain(r.stderr), /! \[projects\] path not scanned: missing \(does not exist\)/);
  });

  it("a [scan] image that is not a valid reference is skipped with a warning", async () => {
    toml(f, '[scan]\ndelegates = ["socket"]\nimages = ["not a valid ref"]\n');
    tool(f, "socket", "exit 0");
    const r = await scan(f, [], { SOCKET_SECURITY_API_TOKEN: "t" });
    assert.equal(r.exitCode, 0, r.stdout + r.stderr);
    assert.match(plain(r.stderr), /! image not scanned: not a valid ref \([^)]+\)/);
  });

  it("a medium finding is printed but does not fail the scan", async () => {
    toml(f, '[scan]\ndelegates = ["grype"]\n');
    const sarif = JSON.stringify({
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "grype",
              rules: [{ id: "R1", properties: { "security-severity": "5.0" } }],
            },
          },
          results: [{ ruleId: "R1", level: "warning", message: { text: "medium thing" } }],
        },
      ],
    });
    tool(f, "grype", `echo '${sarif}'`);
    const r = await scan(f, []);
    assert.equal(r.exitCode, 0, r.stdout + r.stderr);
    assert.match(plain(r.stdout), /\n {2}MEDIUM {3}[^\n]+ {2}\[grype\]\n/);
    assert.doesNotMatch(plain(r.stdout), /high\/critical/);
  });
});
