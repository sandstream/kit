import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPluginAdapters } from "./plugin-loader.js";

// Path-traversal hardening: kitPlugins entries are attacker-influenced (project
// package.json). A name like "../../tmp/evil" used to escape node_modules and get
// import()ed → RCE. These tests prove malicious names are rejected before import.

let tmpProject: string;

before(async () => {
  tmpProject = await mkdtemp(join(tmpdir(), "sandstream-kit-plugin-sec-test-"));
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
  it("refuses a package symlink that resolves outside project node_modules", async () => {
    const outside = join(tmpProject, "external-plugin");
    const marker = join(tmpProject, "external-plugin-ran");
    const linked = join(tmpProject, "node_modules", "kit-plugin-outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(
      join(outside, "index.js"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran"); export const adapter = { name: "outside", description: "outside", getRequiredTools: () => [], check: async () => false, provision: async () => ({ success: true, message: "" }) };`,
    );
    await symlink(outside, linked, "junction");
    try {
      await writeKitPlugins(["kit-plugin-outside"]);
      const { result, warnings } = await withWarnCapture(() => loadPluginAdapters(tmpProject));
      assert.deepEqual(result, {});
      assert.equal(existsSync(marker), false, "external module must not execute");
      assert.ok(warnings.some((warning) => /outside node_modules/.test(warning)));
    } finally {
      await rm(linked, { force: true });
      await rm(outside, { recursive: true, force: true });
      await rm(marker, { force: true });
    }
  });

  it("refuses an entrypoint symlink that resolves outside project node_modules", async () => {
    const outside = join(tmpProject, "external-entry.mjs");
    const marker = join(tmpProject, "external-entry-ran");
    const packageDir = join(tmpProject, "node_modules", "kit-plugin-linked-entry");
    await mkdir(packageDir, { recursive: true });
    await writeFile(
      outside,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran"); export const adapter = { name: "outside", description: "outside", getRequiredTools: () => [], check: async () => false, provision: async () => ({ success: true, message: "" }) };`,
    );
    await symlink(outside, join(packageDir, "index.js"), "file");
    try {
      await writeKitPlugins(["kit-plugin-linked-entry"]);
      const { result, warnings } = await withWarnCapture(() => loadPluginAdapters(tmpProject));
      assert.deepEqual(result, {});
      assert.equal(existsSync(marker), false, "external entrypoint must not execute");
      assert.ok(warnings.some((warning) => /outside node_modules/.test(warning)));
    } finally {
      await rm(packageDir, { recursive: true, force: true });
      await rm(outside, { force: true });
      await rm(marker, { force: true });
    }
  });
});

describe("loadPluginAdapters rejects unsafe package names", () => {
  it("does NOT import a module outside node_modules and does not execute it (RCE guard)", async () => {
    // Plant an evil module OUTSIDE the project's node_modules that, if imported,
    // writes a marker file (stand-in for arbitrary code execution).
    const evilName = "kit-evil";
    const evilDir = join(tmpProject, evilName);
    const marker = join(tmpProject, "kit-pwned.txt");
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
