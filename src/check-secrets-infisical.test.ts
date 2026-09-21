import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecretStatus } from "./check-secrets.js";

const session = {
  tokenSource: "infisical login (keyring)",
  domain: "https://example.test",
  status: "authenticated",
  verification: { state: "verified" },
};

function fallback(
  stdout: string,
  exitCode = 0,
  governedCwd = false,
): { key: SecretStatus; calls: string[][] } {
  const dir = mkdtempSync(join(tmpdir(), "kit-infisical-fallback-"));
  const bin = join(dir, "bin");
  const calls = join(dir, "calls.jsonl");
  mkdirSync(bin);
  const project = join(dir, "project");
  mkdirSync(project);
  writeFileSync(
    join(dir, ".infisical.json"),
    JSON.stringify({ domain: "https://wrong.example.test" }),
  );
  writeFileSync(
    join(project, ".infisical.json"),
    JSON.stringify({ domain: "https://example.test" }),
  );
  const executable = (name: string, source: string) => {
    writeFileSync(join(bin, name), `#!${process.execPath}\n${source}`, { mode: 0o755 });
  };
  executable("mise", "process.exitCode = 1;");
  executable("which", `console.log(${JSON.stringify(join(bin, "infisical"))});`);
  executable(
    "infisical",
    `
    const fs = require("node:fs");
    const args = process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
    if (args[0] === "user" && args[1] === "get") {
      console.log("Usage:\\n  infisical user get [command]\\nFlags:\\n  --help");
    } else if (args[0] === "login" && args[1] === "status") {
      process.stdout.write(${JSON.stringify(stdout)});
      process.exitCode = ${exitCode};
    } else {
      throw new Error("Unexpected command: only status probes are permitted");
    }
  `,
  );
  try {
    const sourceMode = import.meta.url.endsWith(".ts");
    const moduleUrl = new URL(
      sourceMode ? "./check-secrets.ts" : "./check-secrets.js",
      import.meta.url,
    ).href;
    const source = `
      import { checkSecrets } from ${JSON.stringify(moduleUrl)};
      const result = await checkSecrets({store:"infisical", keys:{API_KEY:{source:"infisical"}}}, ${governedCwd ? JSON.stringify(project) : "undefined"});
      console.log(JSON.stringify(result.keys[0]));
    `;
    const result = execFileSync(
      process.execPath,
      [
        ...(sourceMode ? ["--import", import.meta.resolve("tsx")] : []),
        "--input-type=module",
        "-e",
        source,
      ],
      {
        cwd: dir,
        // Never inherit operator credentials or reach the real Infisical CLI.
        env: { PATH: bin, ...(governedCwd ? {} : { INFISICAL_DOMAIN: "https://example.test" }) },
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    return {
      key: JSON.parse(result),
      calls: readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Infisical secret fallback", () => {
  for (const { label, output, exitCode } of [
    {
      label: "help with exit 0",
      output: "Usage:\n  infisical login status\nFlags:\n  --json",
      exitCode: 0,
    },
    { label: "missing session", output: '{"sessions":[]}', exitCode: 1 },
    {
      label: "unverified backend",
      output: JSON.stringify({ sessions: [{ ...session, verification: { state: "unknown" } }] }),
      exitCode: 0,
    },
    {
      label: "expired session",
      output: JSON.stringify({
        sessions: [{ ...session, status: "expired", verification: { state: "skipped" } }],
      }),
      exitCode: 1,
    },
    {
      label: "different domain",
      output: JSON.stringify({ sessions: [{ ...session, domain: "https://wrong.example.test" }] }),
      exitCode: 0,
    },
  ]) {
    it(`does not claim authentication from ${label}`, () => {
      const { key, calls } = fallback(output, exitCode);
      assert.equal(key.available, false);
      assert.notEqual(key.unverified, true, "failed authentication must fail the secret check");
      assert.match(key.detail, /authentication not verified/);
      assert.doesNotMatch(key.detail, /CLI authenticated/);
      assert.deepEqual(
        calls.map((args) => args.slice(0, 2)),
        [["login", "status"]],
      );
    });
  }

  it("keeps secret presence unverified after authenticating the configured session", () => {
    const { key, calls } = fallback(JSON.stringify({ sessions: [session] }));
    assert.equal(key.available, true);
    assert.equal(key.unverified, true);
    assert.match(key.detail, /key presence not verified/);
    assert.deepEqual(calls, [["login", "status", "--json", "--silent", "--telemetry=false"]]);
  });

  it("checks the governed project's domain rather than the caller's binding", () => {
    const { key } = fallback(JSON.stringify({ sessions: [session] }), 0, true);
    assert.equal(key.available, true);
    assert.equal(key.unverified, true);
  });
});
