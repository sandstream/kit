import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliResult } from "../cli-run.test-support.js";

export const EMPTY_SARIF = JSON.stringify({
  version: "2.1.0",
  runs: [{ tool: { driver: { name: "grype", rules: [] } }, results: [] }],
});

export const SOCKET_PASS = `echo '{"ok":true,"data":{"healthy":true,"alerts":{}}}'; exit 0`;
export const SOCKET_FAIL = `echo '{"ok":true,"data":{"healthy":false,"alerts":{}}}'; exit 1`;

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

export function tool(f: Fixture, name: string, body: string, withInventory = true): void {
  const p = join(f.bin, name);
  const witness =
    name === "grype" && withInventory
      ? `
for arg in "$@"; do
  case "$arg" in
    cyclonedx-json=*) printf '{"bomFormat":"CycloneDX","specVersion":"1.6","metadata":{"component":{"name":"%s","type":"file"},"tools":{"components":[{"name":"grype"}]}},"components":[{"type":"library","name":"fixture","version":"1","bom-ref":"fixture","purl":"pkg:npm/fixture@1","properties":[{"name":"syft:location:0:path","value":"/package.json"}]}]}' "$PWD" > "\${arg#*=}" ;;
  esac
done
`
      : "";
  writeFileSync(p, `#!/bin/sh\n${witness}${body}\n`);
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
