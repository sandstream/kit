import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "src", "cli.ts");
const tsx = join(root, "node_modules", ".bin", "tsx");

async function run(args: string[], cwd: string) {
  try {
    const result = await exec(tsx, [cli, ...args], {
      cwd,
      env: { ...process.env, KIT_HIDE_HOOK_SKIP_BANNER: "1", KIT_AUDIT_ANCHOR: "0" },
      timeout: 20_000,
    });
    return { code: 0, ...result };
  } catch (error) {
    const result = error as { code?: number; stdout?: string; stderr?: string };
    return { code: result.code ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
}

describe("plugin command lifecycle", () => {
  it("lists the same project plugin adapter that kit add can provision", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kit-plugin-list-"));
    try {
      const plugin = join(cwd, "node_modules", "kit-plugin-list-test");
      await mkdir(plugin, { recursive: true });
      await writeFile(
        join(cwd, "package.json"),
        JSON.stringify({ kitPlugins: ["kit-plugin-list-test"] }),
      );
      await writeFile(
        join(plugin, "kit-adapter.cjs"),
        'exports.adapter = { name: "plugin/example", description: "Project adapter", getRequiredTools: () => [], check: async () => true, provision: async () => ({ success: true, message: "provisioned" }) };\n',
      );

      const listed = await run(["add", "--list"], cwd);
      assert.equal(listed.code, 0, listed.stderr);
      assert.match(listed.stdout, /plugin\/example/);
      assert.match(listed.stdout, /Project adapter/);

      const provisioned = await run(["add", "plugin/example"], cwd);
      assert.equal(provisioned.code, 0, provisioned.stderr + provisioned.stdout);
      assert.match(provisioned.stdout, /already provisioned/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reports an invalid create-plugin name without a stack trace", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kit-plugin-invalid-"));
    try {
      const result = await run(["create-plugin", "../escape", "--skip-install"], cwd);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Invalid plugin scaffold name/);
      assert.doesNotMatch(result.stderr, /\n\s+at /);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("plugin scaffold --skip-install creates a package without invoking npm", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kit-plugin-skip-"));
    try {
      const result = await run(["plugin", "scaffold", "skip-check", "--skip-install"], cwd);
      assert.equal(result.code, 0, result.stderr + result.stdout);
      const pkg = JSON.parse(
        await readFile(join(cwd, "kit-plugin-skip-check", "package.json"), "utf8"),
      );
      assert.equal(pkg.name, "kit-plugin-skip-check");
      assert.equal(existsSync(join(cwd, "kit-plugin-skip-check", "node_modules")), false);
      assert.match(result.stdout, /npm install --include=dev/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
