import type { TestContext } from "node:test";
import { execFile } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

const exec = promisify(execFile);

export async function fixture(
  t: TestContext,
  deviceId = "pal-cli-device",
  environment: NodeJS.ProcessEnv = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kit-pal-cli-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await exec("git", ["init", "-q", root]);
  const dbPath = join(root, "store", "memory.db");
  const source = import.meta.url.endsWith(".ts");
  const runner = [
    ...(source ? ["--import", import.meta.resolve("tsx")] : []),
    fileURLToPath(new URL(source ? "../cli.ts" : "../cli.js", import.meta.url)),
  ];
  const invokeMemory = async (args: string[], leading: string[] = [], cwd = root) => {
    const result = await exec(process.execPath, [...runner, ...leading, "memory", ...args], {
      cwd,
      env: {
        ...process.env,
        ...environment,
        KIT_MEMORY_DIR: join(root, "store"),
        KIT_MEMORY_DB: dbPath,
        KIT_DEVICE_ID: deviceId,
        KIT_IDENTITY_DIR: join(root, "identity"),
        KIT_NO_UPDATE_CHECK: "1",
        KIT_AUDIT_ANCHOR: "0",
        KIT_NON_INTERACTIVE: "1",
      },
      timeout: 30_000,
    });
    return result.stdout;
  };
  const invoke = (args: string[], leading: string[] = [], cwd = root) =>
    invokeMemory(["pal", ...args], leading, cwd);
  return {
    cli: (...args: string[]) => invoke(args),
    memory: (...args: string[]) => invokeMemory(args),
    invoke,
    dbPath,
    root,
  };
}

export function storedAction(path: string, id: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare("SELECT * FROM pending_actions WHERE id=?").get(id);
  } finally {
    db.close();
  }
}
