/**
 * The 7.4.0 tarball shipped `skills/triage/scripts/__pycache__/*.pyc`: CI runs the triage Python
 * before the publish step, and `files` includes all of `skills`. Compiled bytecode is not source a
 * reader can review, and it differs per Python version. This test packs the real package with a
 * planted bytecode file and checks that npm leaves it out.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PYCACHE = join(ROOT, "skills", "triage", "scripts", "__pycache__");

function packedPaths(): string[] {
  // npm on Windows is a .cmd shim, which execFile can only start through a shell.
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 64 * 1024 * 1024,
  });
  const [pack] = JSON.parse(out) as { files: { path: string }[] }[];
  return pack.files.map((f) => f.path.replaceAll("\\", "/"));
}

describe("npm package contents", () => {
  it("leaves out Python bytecode under skills/", { timeout: 120_000 }, () => {
    const hadDir = existsSync(PYCACHE);
    const probe = join(PYCACHE, "kit_pack_probe.cpython-312.pyc");
    const loose = join(ROOT, "skills", "triage", "scripts", "kit_pack_probe.pyc");
    mkdirSync(PYCACHE, { recursive: true });
    writeFileSync(probe, "probe");
    writeFileSync(loose, "probe");
    try {
      const paths = packedPaths();
      assert.ok(paths.includes("skills/triage/scripts/triage.py"), "the skill source is packed");
      const bytecode = paths.filter((p) => p.includes("__pycache__/") || p.endsWith(".pyc"));
      assert.deepEqual(bytecode, [], "no Python bytecode in the package");
    } finally {
      rmSync(probe, { force: true });
      rmSync(loose, { force: true });
      if (!hadDir) rmSync(PYCACHE, { recursive: true, force: true });
    }
  });
});
