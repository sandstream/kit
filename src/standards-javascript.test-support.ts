import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { JavaScriptScan } from "./standards-javascript.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const require = createRequire(import.meta.url);
const compiler = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
const scanUrl = new URL("../dist/standards-javascript.js", import.meta.url);

export function scan(source: string, file = "input.ts"): JavaScriptScan {
  const root = mkdtempSync(join(tmpdir(), "kit-standards-javascript-test-"));
  try {
    const project = join(root, "project");
    const bin = join(root, "bin");
    mkdirSync(project);
    mkdirSync(bin);
    writeFileSync(join(project, file), source);
    const env: NodeJS.ProcessEnv = {
      HOME: root,
      USERPROFILE: root,
      PATH: bin,
      TMPDIR: root,
      TMP: root,
      TEMP: root,
    };
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
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import { scanJavaScript } from ${JSON.stringify(scanUrl.href)};
      console.log(JSON.stringify(await scanJavaScript(process.cwd())));
    `,
      ],
      {
        cwd: project,
        env,
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout) as JavaScriptScan;
  } finally {
    rmTemp(root);
  }
}
