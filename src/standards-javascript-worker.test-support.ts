import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerOutput } from "./standards-javascript-worker-protocol.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const compiler = createRequire(import.meta.url).resolve("typescript");
const worker = fileURLToPath(new URL("../dist/standards-javascript-worker.js", import.meta.url));

export function requestFile(path: string, text: string) {
  return { path, text, sha256: createHash("sha256").update(text).digest("hex") };
}

/** Exercise the shipped helper's process protocol with an external compiler installation. */
export function runWorker(request: unknown, compilerPatch = "") {
  const root = mkdtempSync(join(tmpdir(), "kit-worker-protocol-"));
  try {
    const input = join(root, "request.json");
    writeFileSync(input, JSON.stringify(request), { mode: 0o600 });
    let api = compiler;
    if (compilerPatch) {
      api = join(root, "compiler.cjs");
      writeFileSync(
        api,
        `module.exports = { ...require(${JSON.stringify(compiler)}) };\n${compilerPatch}\n`,
      );
    }
    const child = spawnSync(process.execPath, [worker, api, input], {
      cwd: root,
      env: {
        HOME: root,
        USERPROFILE: root,
        TMP: root,
        TEMP: root,
        TMPDIR: root,
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
      },
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
    assert.ifError(child.error);
    assert.equal(child.signal, null, child.stderr);
    assert.ok(child.status === 0 || child.status === 1, child.stderr);
    return {
      exit: child.status,
      report: JSON.parse(child.stdout) as WorkerOutput,
      stdout: child.stdout,
    };
  } finally {
    rmTemp(root);
  }
}
