import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JavaScriptScan } from "./standards-javascript.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const compilerApi = createRequire(import.meta.url).resolve("typescript");
// Source tests also exercise the built public runner and its adjacent process helper.
const scanner = new URL("../dist/standards-javascript.js", import.meta.url);

function installCompiler(root: string, fault: string): string {
  const compiler = join(root, "compiler");
  mkdirSync(join(compiler, "bin"), { recursive: true });
  mkdirSync(join(compiler, "lib"));
  const version = createRequire(import.meta.url)("typescript/package.json").version;
  writeFileSync(join(compiler, "package.json"), JSON.stringify({ name: "typescript", version }));
  const executable = join(compiler, "bin", "tsc");
  writeFileSync(executable, "// Compiler fixture installation marker.\n");
  // The external compiler corrupts its process output. Kit's modules run unchanged.
  writeFileSync(
    join(compiler, "lib", "typescript.js"),
    `
const fs = require("node:fs");
module.exports = require(${JSON.stringify(compilerApi)});
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => {
  const report = JSON.parse(String(chunk));
  if (!report.complete || !report.calibration) throw new Error("Fixture compiler did not complete");
  ${fault}
  fs.writeFileSync(${JSON.stringify(join(root, "compiler-receipt.json"))}, JSON.stringify({ pid: process.pid, report }));
  return write(JSON.stringify(report) + "\\n", ...args);
};
`,
  );
  return executable;
}

function fixtureEnvironment(root: string, compiler: string): NodeJS.ProcessEnv {
  const home = join(root, "home");
  const bin = join(root, "bin");
  const temporary = join(root, "tmp");
  for (const path of [home, bin, temporary]) mkdirSync(path);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    PATH: bin,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    KIT_IDENTITY_DIR: join(home, "identity"),
    KIT_AUDIT_ANCHOR_DIR: join(home, "anchors"),
    KIT_MEMORY_DIR: join(home, "memory"),
    KIT_MEMORY_DB: join(home, "memory", "candidate-schema18.db"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"),
  };
  // The request is the last two arguments: a script file shifts them by one, a preload does not.
  const body = `if (process.argv.slice(-2).join(" ") !== "which tsc") process.exit(1);
process.stdout.write(${JSON.stringify(compiler)});`;
  if (process.platform === "win32") {
    copyFileSync(process.execPath, join(bin, "mise.exe"));
    const preload = join(root, "mise.cjs");
    writeFileSync(
      preload,
      `if (require("node:path").basename(process.execPath).toLowerCase() === "mise.exe") { ${body} process.exit(0); }`,
    );
    env.NODE_OPTIONS = `--require=${JSON.stringify(preload)}`;
    env.SystemRoot = process.env.SystemRoot;
    env.WINDIR = process.env.WINDIR;
  } else {
    writeFileSync(join(bin, "mise"), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  }
  return env;
}

export function scanProtocolFixture(files: Record<string, string>, fault = ""): JavaScriptScan {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kit-javascript-protocol-")));
  try {
    const project = join(root, "project");
    mkdirSync(project);
    for (const [path, text] of Object.entries(files)) writeFileSync(join(project, path), text);
    const compiler = installCompiler(root, fault);
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
import { scanJavaScript } from ${JSON.stringify(scanner.href)};
console.log(JSON.stringify(await scanJavaScript(process.cwd())));
`,
      ],
      { cwd: project, env: fixtureEnvironment(root, compiler), encoding: "utf8", timeout: 20_000 },
    );
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    const receipt = JSON.parse(readFileSync(join(root, "compiler-receipt.json"), "utf8"));
    assert.ok(Number.isSafeInteger(receipt.pid), "the external compiler must emit its report");
    assert.notEqual(receipt.pid, child.pid, "the compiler must run in its own process");
    return JSON.parse(child.stdout) as JavaScriptScan;
  } finally {
    rmTemp(root);
  }
}
