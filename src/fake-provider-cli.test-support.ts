import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export const PROVIDER_CLIS = [
  "gh",
  "vercel",
  "fly",
  "flyctl",
  "railway",
  "wrangler",
  "aws",
  "supabase",
];
const CREDENTIALS = [
  "VERCEL_TOKEN",
  "VERCEL_PROJECT_ID",
  "VERCEL_ORG_ID",
  "RAILWAY_TOKEN",
  "RAILWAY_API_TOKEN",
  "FLY_API_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_EMAIL",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "SUPABASE_ACCESS_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
];
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** Local stand-ins prevent adapter tests from reaching installed clients or inherited credentials. */
export function installFakeProviderClis(): { calls: () => string[]; restore: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "kit-fake-providers-"));
  const log = join(directory, "calls.log");
  const previousPath = process.env.PATH;
  const previousFetch = globalThis.fetch;
  const credentials = CREDENTIALS.map((key) => [key, process.env[key]] as const);
  for (const name of PROVIDER_CLIS) {
    const binary = join(directory, name);
    if (process.platform === "win32") copyFileSync(process.execPath, `${binary}.exe`);
    else {
      // Exit immediately. A call without stdin must not wait for a drain.
      writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' ${quote(name)} >> ${quote(log)}\nexit 1\n`);
      chmodSync(binary, 0o755);
    }
  }
  for (const [key] of credentials) delete process.env[key];
  globalThis.fetch = async () => {
    throw new Error("Provider network is disabled in this test fixture");
  };
  process.env.PATH = `${directory}${delimiter}${previousPath ?? ""}`;
  return {
    calls: () => {
      try {
        return readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
    restore: () => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      globalThis.fetch = previousFetch;
      for (const [key, value] of credentials) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
