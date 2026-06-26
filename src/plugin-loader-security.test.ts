import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPluginAdapters } from "./plugin-loader.js";

// Path-traversal hardening: kitPlugins entries are attacker-influenced (project
// package.json). A name like "../../tmp/evil" used to escape node_modules and get
// import()ed → RCE. These tests prove malicious names are rejected before import.

let tmpProject: string;

before(async () => {
  tmpProject = join(tmpdir(), `sandstream-kit-plugin-sec-test-${process.pid}`);
  await mkdir(join(tmpProject, "node_modules"), { recursive: true });
});

after(async () => {
  await rm(tmpProject, { recursive: true, force: true });
});

async function writeKitPlugins(kitPlugins: unknown[]) {
  await writeFile(
    join(tmpProject, "package.json"),
    JSON.stringify({ name: "test-project", kitPlugins }),
    "utf-8",
  );
}

function withWarnCapture<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  return fn()
    .then((result) => ({ result, warnings }))
    .finally(() => {
      console.warn = orig;
    });
}

describe("loadPluginAdapters path-traversal hardening", () => {
  it("does NOT import a module outside node_modules and does not execute it (RCE guard)", async () => {
    // Plant an evil module OUTSIDE the project's node_modules that, if imported,
    // writes a marker file (stand-in for arbitrary code execution).
    const evilName = `kit-evil-${process.pid}`;
    const evilDir = join(tmpdir(), evilName);
    const marker = join(tmpdir(), `kit-pwned-${process.pid}.txt`);
    await mkdir(evilDir, { recursive: true });
    await writeFile(
      join(evilDir, "index.js"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "pwned"); export const adapter = { name: "evil", description: "evil", getRequiredTools: () => [], check: async () => false, provision: async () => ({ success: true, message: "" }) };`,
      "utf-8",
    );
    try {
      // node_modules/<payload> resolves up-and-over into evilDir.
      const payload = `../${evilName}`;
      await writeKitPlugins([payload]);

      const { result, warnings } = await withWarnCapture(() => loadPluginAdapters(tmpProject));

      assert.deepEqual(result, {}, "traversal payload must not register any adapter");
      assert.equal(existsSync(marker), false, "evil module must NOT have been imported/executed");
      assert.ok(
        warnings.some((w) => w.includes(payload)),
        `expected a warning naming the rejected payload, got: ${JSON.stringify(warnings)}`,
      );
    } finally {
      await rm(evilDir, { recursive: true, force: true });
      await rm(marker, { force: true });
    }
  });

  it("rejects assorted malicious / non-package names without throwing", async () => {
    const malicious = [
      "../../etc/passwd",
      "..",
      "./relative",
      "/abs/path",
      "foo/../bar",
      "name\\with\\backslash",
      "@scope/sub/too/deep",
      "@/missing-scope",
    ];
    await writeKitPlugins(malicious);

    const { result, warnings } = await withWarnCapture(() => loadPluginAdapters(tmpProject));

    assert.deepEqual(result, {}, "no malicious name should register an adapter");
    for (const name of malicious) {
      assert.ok(
        warnings.some((w) => w.includes(name) && /[Ii]nvalid plugin name/.test(w)),
        `expected "Invalid plugin name" warning for ${JSON.stringify(name)}, got: ${JSON.stringify(warnings)}`,
      );
    }
  });

  it("still accepts valid scoped and unscoped package names", async () => {
    // Valid names pass validation; they fail later only because they aren't installed,
    // which is the normal "missing plugin" path (warns, never throws).
    await writeKitPlugins(["@acme/kit-railway", "sandstream-kit-plugin-aws-s3"]);

    const { result, warnings } = await withWarnCapture(() => loadPluginAdapters(tmpProject));

    assert.deepEqual(result, {});
    // These must NOT be rejected as invalid names — only fail to import (not found).
    assert.ok(
      !warnings.some((w) => /[Ii]nvalid plugin name/.test(w)),
      `valid names must not be rejected as invalid, got: ${JSON.stringify(warnings)}`,
    );
  });
});
