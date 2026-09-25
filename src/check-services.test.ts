import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, linkSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkServices } from "./check-services.js";
import { isInfisicalLoginStatus } from "./infisical-status.js";

const infisicalHelp = `Used to get properties of an Infisical profile

Usage:
  infisical user get
  infisical user get [command]

Available Commands:
  token       Used to get the access token of an Infisical user

Flags:
  -h, --help   help for get

Use "infisical user get [command] --help" for more information about a command.
`;

async function withCli(
  name: string,
  stdout: string,
  stderr: string,
  exitCode: number,
  run: (bin: string, cwd: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "kit-service-check-"));
  const windows = process.platform === "win32";
  const bin = join(dir, windows ? `${name}.exe` : name);
  const source =
    `process.stdout.write(${JSON.stringify(stdout)});\n` +
    `process.stderr.write(${JSON.stringify(stderr)});\n` +
    `process.exitCode = ${exitCode};\n`;
  if (windows) {
    // On Windows an extensionless shebang cannot be spawned with execFile.
    // Node.exe loads the first command word as a script from this test cwd.
    try {
      linkSync(process.execPath, bin);
    } catch {
      copyFileSync(process.execPath, bin);
    }
    for (const word of ["login", "user", "run", "status"]) {
      writeFileSync(join(dir, word), source);
    }
  } else {
    writeFileSync(bin, `#!${process.execPath}\n${source}`, { mode: 0o755 });
  }
  try {
    await run(bin, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("checkServices Infisical command detection", () => {
  for (const stream of ["stdout", "stderr"] as const) {
    it(`does not authenticate Infisical when exit 0 only prints help on ${stream}`, async () => {
      await withCli(
        "infisical",
        stream === "stdout" ? infisicalHelp : "",
        stream === "stderr" ? infisicalHelp : "",
        0,
        async (bin, cwd) => {
          const [result] = await checkServices(
            { vault: { login: "", check: `${bin} user get` } },
            cwd,
          );
          assert.equal(result.authenticated, false, "help output does not verify authentication");
          assert.match(result.output, /not verified/i);
          assert.match(result.output, /infisical login status --json/);
          assert.notEqual(result.informational, true, "a broken executable check must fail");
        },
      );
    });
  }

  it("rejects ANSI help on stderr even when stdout contains a banner", async () => {
    await withCli(
      "infisical",
      "CLI banner",
      `\u001b[32m${infisicalHelp}\u001b[0m`,
      0,
      async (bin, cwd) => {
        const [result] = await checkServices(
          { vault: { login: "", check: `${bin} user get` } },
          cwd,
        );
        assert.equal(result.authenticated, false);
        assert.match(result.output, /printed help/);
      },
    );
  });

  for (const args of [
    "--domain https://example.test --silent login status --json",
    "--domain=https://example.test login --silent status --json",
  ]) {
    it(`validates status with global flags: ${args}`, async () => {
      const output = '{"sessions":[{"status":"authenticated","verification":{"state":"unknown"}}]}';
      assert.equal(isInfisicalLoginStatus(args.split(/\s+/)), true);
      await withCli("infisical", output, "", 0, async (bin, cwd) => {
        // node.exe uses its first argument as a script on Windows. Put `login`
        // first there, while the direct assertion above keeps pre-login flags covered.
        const executableArgs =
          process.platform === "win32" ? `login ${args.replace(" login", "")}` : args;
        const [result] = await checkServices(
          { vault: { login: "", check: `${bin} ${executableArgs}` } },
          cwd,
        );
        assert.equal(result.authenticated, false);
        assert.match(result.output, /not verified/);
      });
    });
  }

  it("does not interpret an application's arguments as an Infisical status check", async () => {
    await withCli("infisical", "application succeeded", "", 0, async (bin, cwd) => {
      const [result] = await checkServices(
        { vault: { login: "", check: `${bin} run -- app login status` } },
        cwd,
      );
      assert.equal(result.authenticated, true);
      assert.equal(result.output, "application succeeded");
    });
  });
});

const verifiedSession = {
  tokenSource: "infisical login (keyring)",
  domain: "https://example.test",
  status: "authenticated",
  verification: { state: "verified" },
  email: "private-identity@example.test",
};

const verificationCases = [
  {
    label: "backend-verified session",
    stdout: JSON.stringify({ sessions: [verifiedSession] }),
    exitCode: 0,
    authenticated: true,
  },
  {
    label: "ambiguous duplicate keyring sessions",
    stdout: JSON.stringify({ sessions: [verifiedSession, verifiedSession] }),
    exitCode: 0,
    authenticated: false,
  },
  ...["unknown", "skipped", "rejected"].map((state) => ({
    label: `${state} backend verification despite exit 0`,
    stdout: JSON.stringify({
      sessions: [{ ...verifiedSession, verification: { state } }],
    }),
    exitCode: 0,
    authenticated: false,
  })),
  {
    label: "mixed verified and unverified sessions",
    stdout: JSON.stringify({
      sessions: [verifiedSession, { status: "authenticated", verification: { state: "unknown" } }],
    }),
    exitCode: 0,
    authenticated: false,
  },
  {
    label: "expired session",
    stdout: JSON.stringify({ sessions: [{ ...verifiedSession, status: "expired" }] }),
    exitCode: 1,
    authenticated: false,
  },
  {
    label: "nonzero exit despite verified JSON",
    stdout: JSON.stringify({ sessions: [verifiedSession] }),
    exitCode: 1,
    authenticated: false,
  },
  ...[
    "",
    "not JSON",
    infisicalHelp,
    "null",
    "{}",
    '{"sessions":[]}',
    '{"sessions":[null]}',
    '{"sessions":[{"status":"authenticated"}]}',
  ].map((stdout) => ({
    label: `missing or invalid status: ${JSON.stringify(stdout.slice(0, 35))}`,
    stdout,
    exitCode: 0,
    authenticated: false,
  })),
  {
    label: "no login session",
    stdout: '{"sessions":[]}',
    exitCode: 1,
    authenticated: false,
  },
];

describe("checkServices Infisical backend verification", () => {
  for (const { label, stdout, exitCode, authenticated } of verificationCases) {
    it(`requires authenticated status and backend verification: ${label}`, async () => {
      await withCli("infisical", stdout, "", exitCode, async (bin, cwd) => {
        const [result] = await checkServices(
          {
            vault: {
              login: "",
              check: `${bin} login status --json --silent --telemetry=false --domain=https://example.test`,
            },
          },
          cwd,
        );
        assert.equal(result.authenticated, authenticated);
        assert.doesNotMatch(result.output, /private-identity|example\.test|"sessions"/);
        if (!authenticated) assert.match(result.output, /not verified/i);
      });
    });
  }
});

const activeEnvironmentSession = {
  ...verifiedSession,
  tokenSource: "INFISICAL_TOKEN environment variable",
};
const staleKeyring = {
  ...verifiedSession,
  domain: "https://unrelated.example.test",
  status: "expired",
  verification: { state: "skipped" },
};
const configuredSessionCases = [
  {
    label: "active environment credential despite stale keyring and aggregate exit 1",
    sessions: [activeEnvironmentSession, staleKeyring],
    exitCode: 1,
    // Windows cannot distinguish this exit from external process termination.
    authenticated: process.platform !== "win32",
  },
  {
    label: "active environment credential despite unrelated unverified keyring",
    sessions: [
      activeEnvironmentSession,
      { ...staleKeyring, status: "authenticated", verification: { state: "unknown" } },
    ],
    exitCode: 0,
    authenticated: true,
  },
  {
    label: "expired active environment credential cannot fall back to healthy keyring",
    sessions: [{ ...activeEnvironmentSession, status: "expired" }, verifiedSession],
    exitCode: 1,
    authenticated: false,
  },
  {
    label: "healthy active credential for a different domain cannot use matching keyring",
    sessions: [
      { ...activeEnvironmentSession, domain: "https://wrong.example.test" },
      verifiedSession,
    ],
    exitCode: 0,
    authenticated: false,
  },
  {
    label: "wrong-domain keyring alone",
    sessions: [{ ...verifiedSession, domain: "https://wrong.example.test" }],
    exitCode: 0,
    authenticated: false,
  },
  {
    label: "unexpected exit 2 is not the aggregate authentication verdict",
    sessions: [activeEnvironmentSession, staleKeyring],
    exitCode: 2,
    authenticated: false,
  },
  {
    label: "unexplained exit 1 cannot be excused by unknown verification",
    sessions: [
      activeEnvironmentSession,
      { ...staleKeyring, status: "authenticated", verification: { state: "unknown" } },
    ],
    exitCode: 1,
    authenticated: false,
  },
  {
    label: "missing credential source cannot establish selection",
    sessions: [{ ...verifiedSession, tokenSource: undefined }],
    exitCode: 0,
    authenticated: false,
  },
];

describe("checkServices Infisical session selection", () => {
  for (const { label, sessions, exitCode, authenticated } of configuredSessionCases) {
    it(`checks the configured Infisical session: ${label}`, async () => {
      await withCli("infisical", JSON.stringify({ sessions }), "", exitCode, async (bin, cwd) => {
        const [result] = await checkServices(
          {
            vault: {
              login: "",
              check: `${bin} login status --json --silent --domain=https://example.test/api/`,
            },
          },
          cwd,
        );
        assert.equal(result.authenticated, authenticated);
        assert.doesNotMatch(result.output, /private-identity|example\.test|"sessions"/);
      });
    });
  }
});

describe("checkServices arbitrary output", () => {
  for (const output of [
    "",
    "Usage: 42 requests; remaining quota: 958. See help for details.",
    '{"authenticated":true,"help":"Usage: check account limits"}',
    infisicalHelp,
  ]) {
    it(`preserves arbitrary successful service output: ${JSON.stringify(output.slice(0, 65))}`, async () => {
      await withCli("health-check", output, "", 0, async (bin, cwd) => {
        const [result] = await checkServices(
          { infisical: { login: "", check: `${bin} status` } },
          cwd,
        );
        assert.equal(result.authenticated, true);
        assert.equal(result.output, output.trim());
      });
    });
  }
});

describe("checkServices", () => {
  it("returns empty array for empty services config", async () => {
    const results = await checkServices({});
    assert.deepEqual(results, []);
  });

  it("returns authenticated false when no check command configured", async () => {
    const results = await checkServices({
      myservice: {} as any,
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].name, "myservice");
    assert.equal(results[0].authenticated, false);
    assert.ok(results[0].output.includes("No check command"));
  });

  it("returns authenticated true when command succeeds", async () => {
    const results = await checkServices({
      node: { login: "node --version", check: "node --version" },
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].name, "node");
    assert.equal(results[0].authenticated, true);
    assert.equal(results[0].checkCommand, "node --version");
    assert.ok(results[0].output.length > 0);
  });

  it("returns authenticated false when command fails", async () => {
    const results = await checkServices({
      missing: { login: "", check: "definitely-not-a-real-command-xyz --version" },
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].authenticated, false);
  });

  it("checks multiple services independently", async () => {
    const results = await checkServices({
      node: { login: "node --version", check: "node --version" },
      missing: { login: "", check: "nonexistent-tool-abc --version" },
    });

    assert.equal(results.length, 2);
    const nodeResult = results.find((r) => r.name === "node")!;
    const missingResult = results.find((r) => r.name === "missing")!;

    assert.equal(nodeResult.authenticated, true);
    assert.equal(missingResult.authenticated, false);
  });

  it("flags '#'-prefixed check commands as informational without exec", async () => {
    const results = await checkServices({
      resend: { login: "", check: "# resend — set RESEND_API_KEY in env" } as any,
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].authenticated, false);
    assert.equal(results[0].informational, true);
    assert.ok(results[0].output.includes("RESEND_API_KEY"));
    assert.ok(!results[0].output.includes("ENOENT"));
  });

  it("includes check command in result", async () => {
    const results = await checkServices({
      myservice: { login: "node --version", check: "node --version" },
    });

    assert.equal(results[0].checkCommand, "node --version");
  });
});
