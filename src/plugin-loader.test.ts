import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPluginAdapters } from "./plugin-loader.js";

// Build a temporary project with node_modules for mock plugins
let tmpProject: string;

before(async () => {
  tmpProject = join(tmpdir(), `sandstream-kit-plugin-loader-test-${process.pid}`);
  await mkdir(tmpProject, { recursive: true });
});

after(async () => {
  await rm(tmpProject, { recursive: true, force: true });
});

async function writePackageJson(kitPlugins: string[]) {
  await writeFile(
    join(tmpProject, "package.json"),
    JSON.stringify({ name: "test-project", kitPlugins }),
    "utf-8",
  );
}

async function createMockPlugin(pluginName: string, exportContent: string): Promise<void> {
  const pluginDir = join(tmpProject, "node_modules", pluginName);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    join(pluginDir, "package.json"),
    JSON.stringify({ name: pluginName, version: "1.0.0", main: "index.js" }),
    "utf-8",
  );
  await writeFile(join(pluginDir, "index.js"), exportContent, "utf-8");
}

const mockAdapterExport = `
export const adapter = {
  name: "mock/service",
  description: "A mock service adapter",
  getRequiredTools: () => [],
  check: async () => false,
  provision: async () => ({ success: true, message: "provisioned" }),
};
`;

const mockAdaptersArrayExport = `
export const adapters = [
  {
    name: "mock/service-a",
    description: "Mock service A",
    getRequiredTools: () => [],
    check: async () => false,
    provision: async () => ({ success: true, message: "a provisioned" }),
  },
  {
    name: "mock/service-b",
    description: "Mock service B",
    getRequiredTools: () => [],
    check: async () => false,
    provision: async () => ({ success: true, message: "b provisioned" }),
  },
];
`;

describe("loadPluginAdapters", () => {
  it("returns empty registry when package.json has no kitPlugins", async () => {
    await writePackageJson([]);
    const result = await loadPluginAdapters(tmpProject);
    assert.deepEqual(result, {});
  });

  it("returns empty registry when package.json is absent", async () => {
    const emptyDir = join(tmpdir(), `kit-empty-${process.pid}`);
    await mkdir(emptyDir, { recursive: true });
    try {
      const result = await loadPluginAdapters(emptyDir);
      assert.deepEqual(result, {});
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("loads a plugin that exports { adapter }", async () => {
    await createMockPlugin("sandstream-kit-plugin-single", mockAdapterExport);
    await writePackageJson(["sandstream-kit-plugin-single"]);

    const result = await loadPluginAdapters(tmpProject);
    assert.ok(result["mock/service"], "adapter should be registered under its name");
    assert.equal(result["mock/service"].description, "A mock service adapter");
  });

  it("loads a plugin that exports { adapters: [] }", async () => {
    await createMockPlugin("sandstream-kit-plugin-multi", mockAdaptersArrayExport);
    await writePackageJson(["sandstream-kit-plugin-multi"]);

    const result = await loadPluginAdapters(tmpProject);
    assert.ok(result["mock/service-a"], "first adapter registered");
    assert.ok(result["mock/service-b"], "second adapter registered");
    assert.equal(result["mock/service-a"].description, "Mock service A");
    assert.equal(result["mock/service-b"].description, "Mock service B");
  });

  it("loads multiple plugins at once", async () => {
    await createMockPlugin(
      "sandstream-kit-plugin-single2",
      `
      export const adapter = {
        name: "mock/single2",
        description: "Single2",
        getRequiredTools: () => [],
        check: async () => false,
        provision: async () => ({ success: true, message: "ok" }),
      };
    `,
    );
    await createMockPlugin(
      "sandstream-kit-plugin-multi2",
      `
      export const adapters = [{
        name: "mock/multi2",
        description: "Multi2",
        getRequiredTools: () => [],
        check: async () => false,
        provision: async () => ({ success: true, message: "ok" }),
      }];
    `,
    );
    await writePackageJson(["sandstream-kit-plugin-single2", "sandstream-kit-plugin-multi2"]);

    const result = await loadPluginAdapters(tmpProject);
    assert.ok(result["mock/single2"]);
    assert.ok(result["mock/multi2"]);
  });

  it("skips a missing plugin with a warning and does not throw", async () => {
    await writePackageJson(["sandstream-kit-plugin-does-not-exist"]);

    // Capture console.warn
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
      const result = await loadPluginAdapters(tmpProject);
      assert.deepEqual(result, {});
      assert.ok(
        warnings.some((w) => w.includes("sandstream-kit-plugin-does-not-exist")),
        `expected warning about missing plugin, got: ${warnings}`,
      );
    } finally {
      console.warn = orig;
    }
  });

  it("skips a plugin with invalid exports and does not throw", async () => {
    await createMockPlugin(
      "sandstream-kit-plugin-invalid",
      `
      export const notAnAdapter = "this is not an adapter";
    `,
    );
    await writePackageJson(["sandstream-kit-plugin-invalid"]);

    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
      const result = await loadPluginAdapters(tmpProject);
      assert.deepEqual(result, {});
      assert.ok(
        warnings.some((w) => w.includes("sandstream-kit-plugin-invalid")),
        `expected warning about invalid plugin, got: ${warnings}`,
      );
    } finally {
      console.warn = orig;
    }
  });

  it("skips non-string entries in kitPlugins array", async () => {
    await writeFile(
      join(tmpProject, "package.json"),
      JSON.stringify({ name: "test", kitPlugins: [42, null, "not-installed"] }),
      "utf-8",
    );
    // Should not crash; just warn about "not-installed" (which doesn't exist)
    const result = await loadPluginAdapters(tmpProject);
    assert.deepEqual(result, {});
  });

  it("loaded adapters are callable (check and provision work)", async () => {
    await createMockPlugin("sandstream-kit-plugin-callable", mockAdapterExport);
    await writePackageJson(["sandstream-kit-plugin-callable"]);

    const result = await loadPluginAdapters(tmpProject);
    const adapter = result["mock/service"];
    assert.ok(adapter);

    const ctx = { projectPath: tmpProject, existingEnv: {} };
    assert.equal(await adapter.check(ctx), false);
    const provision = await adapter.provision(ctx);
    assert.equal(provision.success, true);
  });
});
