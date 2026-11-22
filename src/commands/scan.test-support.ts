import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliResult } from "../cli-run.test-support.js";

export const EMPTY_SARIF = JSON.stringify({
  version: "2.1.0",
  runs: [{ tool: { driver: { name: "grype", rules: [] } }, results: [] }],
});

export interface Fixture {
  dir: string;
  bin: string;
}

export function makeFixture(): Fixture {
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

export function tool(f: Fixture, name: string, body: string): void {
  const p = join(f.bin, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
}

export function toml(f: Fixture, text: string): void {
  writeFileSync(join(f.dir, ".kit.toml"), text);
}

export function scan(
  f: Fixture,
  args: string[],
  env: Record<string, string> = {},
): Promise<CliResult> {
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
