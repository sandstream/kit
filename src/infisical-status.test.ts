import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkInfisicalStatus } from "./infisical-status.js";

const keyring = {
  tokenSource: "infisical login (keyring)",
  domain: "https://eu.example.test",
  status: "authenticated",
  verification: { state: "verified" },
};

async function probe(options: {
  env?: NodeJS.ProcessEnv;
  args?: string[];
  workspace?: string;
  nestedWorkspace?: string;
  sessions?: unknown[];
  signal?: boolean;
}) {
  const dir = mkdtempSync(join(tmpdir(), "kit-infisical-scope-"));
  const nested = join(dir, "nested");
  mkdirSync(nested);
  writeFileSync(join(dir, ".infisical.json"), options.workspace ?? "{}");
  if (options.nestedWorkspace !== undefined)
    writeFileSync(join(nested, ".infisical.json"), options.nestedWorkspace);
  const windows = process.platform === "win32";
  const command = join(dir, windows ? "infisical.exe" : "infisical");
  const pidPath = join(dir, "status.pid");
  const stdout = JSON.stringify({ sessions: options.sessions ?? [keyring] });
  // Values enter the generated script as base64, never as source text.
  const b64 = (value: string) =>
    `Buffer.from(${JSON.stringify(Buffer.from(value).toString("base64"))}, "base64").toString()`;
  const source = `process.stdout.write(${b64(stdout)}, () => { ${options.signal ? `require("node:fs").writeFileSync(${b64(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);` : ""} });\n`;
  if (windows) {
    // Native Windows needs a PE executable. Node loads `login` from the test
    // cwd as its entry script; remaining status flags stay untouched.
    try {
      linkSync(process.execPath, command);
    } catch {
      copyFileSync(process.execPath, command);
    }
    writeFileSync(join(nested, "login"), source);
  } else {
    writeFileSync(command, `#!${process.execPath}\n${source}`, { mode: 0o755 });
  }
  try {
    const pending = checkInfisicalStatus({
      command,
      cwd: nested,
      env: options.env ?? {},
      args: options.args,
    });
    if (options.signal) {
      // Parent-initiated termination exposes execFile's signal verdict on
      // Windows; self-signalling inside the child can instead exit cleanly.
      for (let i = 0; i < 300 && !existsSync(pidPath); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(existsSync(pidPath), "status fixture did not reach its running state");
      process.kill(Number(readFileSync(pidPath, "utf8")), "SIGTERM");
    }
    return await pending;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const scopeCases = [
  { label: "unqualified keyring uses the selected profile's domain", options: {}, ok: true },
  {
    label: "nearest ancestor workspace domain",
    options: { workspace: '{"domain":"https://eu.example.test/api/"}' },
    ok: true,
  },
  {
    label: "nearest workspace wins over its parent",
    options: {
      workspace: '{"domain":"https://wrong.example.test"}',
      nestedWorkspace: '{"domain":"https://eu.example.test"}',
    },
    ok: true,
  },
  {
    label: "workspace mismatch",
    options: { workspace: '{"domain":"https://wrong.example.test"}' },
    ok: false,
  },
  {
    label: "environment domain overrides workspace",
    options: {
      workspace: '{"domain":"https://wrong.example.test"}',
      env: { INFISICAL_DOMAIN: "https://eu.example.test" },
    },
    ok: true,
  },
  {
    label: "legacy domain environment variable",
    options: { env: { INFISICAL_API_URL: "https://eu.example.test/api" } },
    ok: true,
  },
  {
    label: "current domain variable takes precedence",
    options: {
      env: {
        INFISICAL_DOMAIN: "https://eu.example.test",
        INFISICAL_API_URL: "https://wrong.example.test",
      },
    },
    ok: true,
  },
  {
    label: "explicit flag overrides environment and workspace",
    options: {
      args: ["login", "status", "--json", "--domain=https://eu.example.test"],
      env: { INFISICAL_DOMAIN: "https://wrong.example.test" },
      workspace: '{"domain":"https://wrong.example.test"}',
    },
    ok: true,
  },
  {
    label: "unqualified environment token must use default US domain",
    options: { sessions: [{ ...keyring, tokenSource: "INFISICAL_TOKEN environment variable" }] },
    ok: false,
  },
  {
    label: "default US environment session",
    options: {
      sessions: [
        {
          ...keyring,
          tokenSource: "INFISICAL_TOKEN environment variable",
          domain: "https://app.infisical.com",
        },
      ],
    },
    ok: true,
  },
  {
    label: "unreported higher-priority credential alias",
    options: {
      env: {
        INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN: "synthetic-test-value",
        INFISICAL_DOMAIN: "https://eu.example.test",
      },
      sessions: [{ ...keyring, tokenSource: "INFISICAL_TOKEN environment variable" }],
    },
    ok: false,
  },
  {
    label: "unreported legacy credential alias",
    options: { env: { TOKEN: "synthetic-test-value" } },
    ok: false,
  },
  {
    label: "reported environment credential takes precedence over legacy TOKEN",
    options: {
      env: { TOKEN: "synthetic-test-value", INFISICAL_DOMAIN: "https://eu.example.test" },
      sessions: [{ ...keyring, tokenSource: "INFISICAL_TOKEN environment variable" }],
    },
    ok: true,
  },
  {
    label: "empty credential alias remains conservative without reading its value",
    options: { env: { TOKEN: "" } },
    ok: false,
  },
  {
    label: "explicit token source wins over other credential configuration",
    options: {
      args: [
        "login",
        "status",
        "--json",
        "--domain=https://eu.example.test",
        "--token=synthetic-test-value",
      ],
      env: { INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN: "synthetic-test-value" },
      sessions: [{ ...keyring, tokenSource: "--token flag" }],
    },
    ok: true,
  },
  { label: "malformed workspace JSON", options: { workspace: "{" }, ok: false },
  { label: "invalid workspace shape", options: { workspace: "[]" }, ok: false },
  {
    label: "invalid configured domain",
    options: { env: { INFISICAL_DOMAIN: "not-a-domain" } },
    ok: false,
  },
  { label: "login itself is not a status probe", options: { args: ["login"] }, ok: false },
  {
    label: "signal cannot be excused by a stale secondary session",
    options: {
      env: { INFISICAL_DOMAIN: "https://eu.example.test" },
      sessions: [
        { ...keyring, tokenSource: "INFISICAL_TOKEN environment variable" },
        { ...keyring, status: "expired", verification: { state: "skipped" } },
      ],
      signal: true,
    },
    ok: false,
  },
];

describe("Infisical configured scope", () => {
  for (const { label, options, ok } of scopeCases) {
    it(label, async () => {
      const result = await probe(options);
      assert.equal(result.ok, ok, result.output);
      assert.doesNotMatch(result.output, /synthetic-test-value|example\.test|"sessions"/);
      if (!ok) assert.match(result.output, /authentication not verified/);
    });
  }
});
