import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";

export function planCliFixture(t: TestContext) {
  const parent = mkdtempSync(join(tmpdir(), "kit-plan-cli-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "project-public");
  mkdirSync(root);
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", [
    "-C",
    root,
    "remote",
    "add",
    "origin",
    "https://example.test/team/project.git",
  ]);
  const source = import.meta.url.endsWith(".ts");
  const cli = fileURLToPath(new URL(source ? "../cli.ts" : "../cli.js", import.meta.url));
  const dbPath = join(parent, "memory.db");
  const run = (args: string[], extra: Record<string, string> = {}) => {
    const result = spawnSync(
      process.execPath,
      [...(source ? ["--import", import.meta.resolve("tsx")] : []), cli, "memory", ...args],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          KIT_MEMORY_DB: dbPath,
          KIT_DEVICE_ID: "plan-cli-device",
          KIT_NO_UPDATE_CHECK: "1",
          KIT_NO_HINTS: "1",
          KIT_AUDIT_ANCHOR: "0",
          KIT_NON_INTERACTIVE: "1",
          ...extra,
        },
      },
    );
    return result;
  };
  return { parent, root, dbPath, run, exists: () => existsSync(dbPath) };
}
