import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { TestContext } from "node:test";
import type { JavaScriptScan } from "./standards-javascript.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const require = createRequire(import.meta.url);
const compiler = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
const scanUrl = new URL("../dist/standards-javascript.js", import.meta.url);

export function inventoryFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "kit-js-inventory-"));
  t.after(() => rmTemp(root));
  const project = join(root, "project");
  const bin = join(root, "bin");
  mkdirSync(project);
  mkdirSync(bin);
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    USERPROFILE: root,
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    PATH: `${bin}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}`,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    LC_ALL: "C",
  };
  writeFileSync(env.GIT_CONFIG_GLOBAL!, "");
  if (process.platform === "win32") {
    copyFileSync(process.execPath, join(bin, "mise.exe"));
    const preload = join(root, "tool.cjs");
    writeFileSync(
      preload,
      `if (require('node:path').basename(process.execPath).toLowerCase() === 'mise.exe') { process.stdout.write(${JSON.stringify(compiler)}); process.exit(0); }`,
    );
    env.NODE_OPTIONS = `--require=${JSON.stringify(preload)}`;
    env.SystemRoot = process.env.SystemRoot;
    env.WINDIR = process.env.WINDIR;
  } else {
    writeFileSync(
      join(bin, "mise"),
      `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(compiler)});\n`,
      { mode: 0o755 },
    );
  }
  function gitInput(input: string | Buffer, ...args: string[]): string {
    const child = spawnSync("git", args, {
      cwd: project,
      env,
      input,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    return child.stdout;
  }
  function git(...args: string[]): string {
    return gitInput("", ...args);
  }
  function scanMeasured(): { result: JavaScriptScan; maxRSS: number } {
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import { scanJavaScript } from ${JSON.stringify(scanUrl.href)};
      const result = await scanJavaScript(process.cwd());
      console.log(JSON.stringify({ result, maxRSS: process.resourceUsage().maxRSS }));
    `,
      ],
      { cwd: project, env, encoding: "utf8", timeout: 20_000 },
    );
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout) as { result: JavaScriptScan; maxRSS: number };
  }
  function scan(): JavaScriptScan {
    return scanMeasured().result;
  }
  git("init", "--quiet");
  return { root, project, bin, env, git, gitInput, scan, scanMeasured };
}
