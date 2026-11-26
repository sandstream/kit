/**
 * The win32 npm-shim parser, fed shim text in the exact forms the generators write (npm's
 * `cmd-shim` 7, yarn v1's vendored copy, pnpm's `@zkochan/cmd-shim` 7). Pure text: runs on every OS.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { posix } from "node:path";
import { isBatchFile, parseNpmShim, shimTargetPath, type ShimTarget } from "./win-npm-shim.js";

const CRLF = (lines: string[]) => lines.join("\r\n") + "\r\n";

/** npm 7+ (`cmd-shim` ≥ 3), as `writeShim_` builds it for a `#!/usr/bin/env node` bin. */
function npmShim(target: string): string {
  return CRLF([
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`,
  ]);
}

/** yarn v1 (and npm < 7): the `IF EXIST "%~dp0\node.exe"` form. */
function yarnShim(target: string): string {
  return CRLF([
    '@IF EXIST "%~dp0\\node.exe" (',
    `  "%~dp0\\node.exe"  "%~dp0\\${target}" %*`,
    ") ELSE (",
    "  @SETLOCAL",
    "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
    `  node  "%~dp0\\${target}" %*`,
    ")",
  ]);
}

/** pnpm (`@zkochan/cmd-shim`), with the NODE_PATH preamble pnpm writes for global installs. */
function pnpmShim(target: string): string {
  return CRLF([
    "@SETLOCAL",
    "@IF NOT DEFINED NODE_PATH (",
    '  @SET "NODE_PATH=C:\\Users\\a b\\AppData\\Local\\pnpm\\global\\5\\node_modules"',
    ") ELSE (",
    '  @SET "NODE_PATH=C:\\Users\\a b\\AppData\\Local\\pnpm\\global\\5\\node_modules;%NODE_PATH%"',
    ")",
    '@IF EXIST "%~dp0\\node.exe" (',
    `  "%~dp0\\node.exe"  "%~dp0\\${target}" %*`,
    ") ELSE (",
    "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
    `  node  "%~dp0\\${target}" %*`,
    ")",
  ]);
}

function okTarget(text: string): ShimTarget {
  const r = parseNpmShim(text);
  assert.ok(r.ok, r.ok ? "" : r.reason);
  return r.target;
}

function refused(text: string, why: RegExp): void {
  const r = parseNpmShim(text);
  assert.equal(r.ok, false, "kit must refuse this shim");
  if (!r.ok) assert.match(r.reason, why);
}

describe("win32 npm shim parser accepts supported shims", () => {
  it("reads npm 7+ cmd-shim output", () => {
    const t = okTarget(npmShim("node_modules\\vercel\\dist\\vc.js"));
    assert.deepEqual(t, {
      runner: "node",
      relative: true,
      segments: ["node_modules", "vercel", "dist", "vc.js"],
      absolute: "",
    });
  });

  it("reads yarn v1's shim (both branches name one target)", () => {
    const t = okTarget(yarnShim("..\\Data\\global\\node_modules\\eas-cli\\bin\\run"));
    assert.equal(t.runner, "node");
    assert.deepEqual(t.segments, ["..", "Data", "global", "node_modules", "eas-cli", "bin", "run"]);
  });

  it("reads pnpm's shim, NODE_PATH preamble included", () => {
    const t = okTarget(pnpmShim("..\\wrangler\\bin\\wrangler.js"));
    assert.deepEqual(t.segments, ["..", "wrangler", "bin", "wrangler.js"]);
  });

  it("reads pnpm's absolute node program and absolute target", () => {
    const text =
      '@SETLOCAL\r\n@"C:\\Program Files\\nodejs\\node.exe"  "D:\\pnpm store\\x\\cli.js" %*\r\n';
    const t = okTarget(text);
    assert.equal(t.relative, false);
    assert.equal(t.absolute, "D:\\pnpm store\\x\\cli.js");
  });

  it("keeps a quoted path with spaces as one path", () => {
    const t = okTarget(npmShim("node_modules\\my cli\\bin dir\\run me.js"));
    assert.deepEqual(t.segments, ["node_modules", "my cli", "bin dir", "run me.js"]);
    const p = shimTargetPath(t, "/home/a b/npm", posix.join);
    assert.equal(p, "/home/a b/npm/node_modules/my cli/bin dir/run me.js");
  });

  it("resolves .. segments against the shim's directory", () => {
    const t = okTarget(npmShim("..\\vercel\\dist\\vc.js"));
    assert.equal(
      shimTargetPath(t, "/p/node_modules/.bin", posix.join),
      "/p/node_modules/vercel/dist/vc.js",
    );
  });

  it("accepts a no-shebang shim only when it starts an .exe", () => {
    const head =
      "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n";
    const t = okTarget(`${head}"%dp0%\\node_modules\\supabase\\bin\\supabase.exe"   %*\r\n`);
    assert.equal(t.runner, "direct");
    refused(`${head}"%dp0%\\node_modules\\x\\bin\\x"   %*\r\n`, /not an \.exe/);
  });
});

describe("win32 npm shim parser validates batch input", () => {
  it("refuses text with no invocation", () => {
    refused("@ECHO off\r\necho hello\r\n", /no invocation/);
    refused("", /no invocation/);
  });

  it("refuses a program other than node", () => {
    refused(npmShim("x.js").replace('SET "_prog=node"', 'SET "_prog=powershell"'), /_prog/);
    refused('@"%~dp0\\evil.bat" "%~dp0\\x.js" %*\r\n', /not node/);
    refused('@cmd /c "%~dp0\\x.js" %*\r\n', /not node/);
  });

  it("refuses interpreter arguments (code kit would not hash)", () => {
    refused('@node --require "%~dp0\\pre.js" "%~dp0\\x.js" %*\r\n', /interpreter arguments/);
    refused('@node "%~dp0\\x.js" --flag %*\r\n', /interpreter arguments/);
  });

  it("refuses a target written with another variable or a relative path", () => {
    refused('@node "%APPDATA%\\x.js" %*\r\n', /variable/);
    refused('@node "%~dp0\\%X%\\x.js" %*\r\n', /variable/);
    refused('@node "x.js" %*\r\n', /neither shim-relative nor absolute/);
  });

  it("refuses branches that disagree on the target", () => {
    const text = yarnShim("a.js").replace('node  "%~dp0\\a.js"', 'node  "%~dp0\\b.js"');
    refused(text, /disagree/);
  });

  it("refuses an unbalanced quote", () => {
    refused('@node "%~dp0\\x.js %*\r\n', /cannot read invocation/);
  });

  it("knows a batch file by extension, case-insensitively", () => {
    assert.equal(isBatchFile("C:\\npm\\vercel.CMD"), true);
    assert.equal(isBatchFile("x.bat"), true);
    assert.equal(isBatchFile("x.exe"), false);
    assert.equal(isBatchFile("/usr/bin/vercel"), false);
  });
});
