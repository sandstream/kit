import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPluginInfo, uninstallPlugin } from "./plugins.js";

describe("official plugin uninstall", () => {
  it("removes the npm package and adapter registration while preserving other project fields", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kit-plugin-uninstall-"));
    const manifest = join(cwd, "package.json");
    const railway = getPluginInfo("railway");
    assert.ok(railway?.package);
    try {
      await writeFile(
        manifest,
        JSON.stringify({
          name: "app",
          dependencies: { [railway.package]: "6.12.0", lodash: "4.17.21" },
          kitPlugins: [railway.package, "kit-plugin-other"],
          scripts: { test: "node --test" },
        }),
      );
      const commands: string[] = [];
      const result = await uninstallPlugin(
        "railway",
        railway,
        {
          exec: async (command, args) => {
            commands.push(`${command} ${args.join(" ")}`);
            const pkg = JSON.parse(await readFile(manifest, "utf8"));
            delete pkg.dependencies[railway.package!];
            await writeFile(manifest, JSON.stringify(pkg));
            return { stdout: "", stderr: "" };
          },
        },
        cwd,
      );

      assert.equal(result.success, true, result.message);
      assert.deepEqual(commands, [`npm uninstall --ignore-scripts ${railway.package}`]);
      const pkg = JSON.parse(await readFile(manifest, "utf8"));
      assert.deepEqual(pkg.dependencies, { lodash: "4.17.21" });
      assert.deepEqual(pkg.kitPlugins, ["kit-plugin-other"]);
      assert.deepEqual(pkg.scripts, { test: "node --test" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps adapter registration when npm refuses to uninstall", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kit-plugin-uninstall-fail-"));
    const manifest = join(cwd, "package.json");
    const railway = getPluginInfo("railway");
    assert.ok(railway?.package);
    try {
      const original = JSON.stringify({ name: "app", kitPlugins: [railway.package] });
      await writeFile(manifest, original);
      const result = await uninstallPlugin(
        "railway",
        railway,
        {
          exec: async () => {
            throw new Error("npm refused");
          },
        },
        cwd,
      );
      assert.equal(result.success, false);
      assert.match(result.message, /npm refused/);
      assert.match(result.message, /kitPlugins.*not removed/i);
      assert.equal(await readFile(manifest, "utf8"), original);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("official API package uninstall", () => {
  it("removes an API-only package without creating kitPlugins", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kit-plugin-api-uninstall-"));
    const manifest = join(cwd, "package.json");
    const stripe = getPluginInfo("stripe");
    assert.ok(stripe?.package);
    assert.equal(stripe.adapter, undefined);
    try {
      await writeFile(
        manifest,
        JSON.stringify({ name: "app", dependencies: { [stripe.package]: "6.12.0" } }),
      );
      const result = await uninstallPlugin(
        "stripe",
        stripe,
        {
          exec: async () => {
            await writeFile(manifest, JSON.stringify({ name: "app", dependencies: {} }));
            return { stdout: "", stderr: "" };
          },
        },
        cwd,
      );
      assert.equal(result.success, true, result.message);
      const pkg = JSON.parse(await readFile(manifest, "utf8"));
      assert.deepEqual(pkg.dependencies, {});
      assert.equal(Object.hasOwn(pkg, "kitPlugins"), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("cleans up an old manual registration for an API-only package", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kit-plugin-uninstall-api-"));
    const manifest = join(cwd, "package.json");
    const stripe = getPluginInfo("stripe");
    assert.ok(stripe?.package);
    assert.ok(!stripe.adapter);
    try {
      await writeFile(manifest, JSON.stringify({ name: "app", kitPlugins: [stripe.package] }));
      const result = await uninstallPlugin(
        "stripe",
        stripe,
        { exec: async () => ({ stdout: "", stderr: "" }) },
        cwd,
      );
      assert.equal(result.success, true, result.message);
      const pkg = JSON.parse(await readFile(manifest, "utf8"));
      assert.deepEqual(pkg.kitPlugins, []);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("official plugin uninstall guardrails", () => {
  it("refuses uninstall in read-only mode before npm or manifest mutation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kit-plugin-uninstall-readonly-"));
    const manifest = join(cwd, "package.json");
    const railway = getPluginInfo("railway");
    assert.ok(railway?.package);
    const previous = process.env.KIT_READ_ONLY;
    try {
      const original = JSON.stringify({ name: "app", kitPlugins: [railway.package] });
      await writeFile(manifest, original);
      process.env.KIT_READ_ONLY = "1";
      let npmCalled = false;
      const result = await uninstallPlugin(
        "railway",
        railway,
        {
          exec: async () => {
            npmCalled = true;
            return { stdout: "", stderr: "" };
          },
        },
        cwd,
      );
      assert.equal(result.success, false);
      assert.match(result.message, /read-only/i);
      assert.equal(npmCalled, false);
      assert.equal(await readFile(manifest, "utf8"), original);
    } finally {
      if (previous === undefined) delete process.env.KIT_READ_ONLY;
      else process.env.KIT_READ_ONLY = previous;
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("official plugin uninstall partial outcomes", () => {
  it("reports a partial failure when npm removes the package but registration cannot be updated", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kit-plugin-uninstall-partial-"));
    const manifest = join(cwd, "package.json");
    const railway = getPluginInfo("railway");
    assert.ok(railway?.package);
    try {
      await writeFile(manifest, JSON.stringify({ name: "app", kitPlugins: [railway.package] }));
      const result = await uninstallPlugin(
        "railway",
        railway,
        {
          exec: async () => {
            await writeFile(manifest, JSON.stringify({ name: "app", kitPlugins: "invalid" }));
            return { stdout: "", stderr: "" };
          },
        },
        cwd,
      );
      assert.equal(result.success, false);
      assert.match(result.message, /Package removed by npm.*kitPlugins/);
      assert.match(result.message, /Remove it from package.json manually/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects a non-registry package name before invoking npm", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kit-plugin-uninstall-spec-"));
    const railway = getPluginInfo("railway");
    assert.ok(railway);
    try {
      await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "app" }));
      let npmCalled = false;
      const result = await uninstallPlugin(
        "railway",
        { ...railway, package: "--global" },
        {
          exec: async () => {
            npmCalled = true;
            return { stdout: "", stderr: "" };
          },
        },
        cwd,
      );
      assert.equal(result.success, false);
      assert.match(result.message, /non-registry/i);
      assert.equal(npmCalled, false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("official plugin uninstall failures", () => {
  it("redacts credentials embedded in npm uninstall errors", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kit-plugin-uninstall-secret-"));
    const railway = getPluginInfo("railway");
    assert.ok(railway?.package);
    try {
      await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "app" }));
      const result = await uninstallPlugin(
        "railway",
        railway,
        {
          exec: async () => {
            throw new Error("fetch failed at https://alice:topsecret123@registry.invalid/plugin");
          },
        },
        cwd,
      );
      assert.equal(result.success, false);
      assert.match(result.message, /\[REDACTED\]/);
      assert.doesNotMatch(result.message, /topsecret123/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("official plugin manifest failures", () => {
  it("reports write and rename failures without discarding adapter registration", async () => {
    const railway = getPluginInfo("railway");
    assert.ok(railway?.package);
    for (const phase of ["write", "rename"] as const) {
      const cwd = await mkdtemp(join(tmpdir(), `kit-plugin-uninstall-${phase}-`));
      const manifest = join(cwd, "package.json");
      try {
        const original: string = JSON.stringify({ name: "app", kitPlugins: [railway.package] });
        await writeFile(manifest, original);
        const result = await uninstallPlugin(
          "railway",
          railway,
          {
            exec: async () => ({ stdout: "", stderr: "" }),
            manifestIO: {
              writeFile:
                phase === "write"
                  ? async () => {
                      throw new Error("write refused");
                    }
                  : writeFile,
              rename: async () => {
                throw new Error("rename refused");
              },
            },
          },
          cwd,
        );
        assert.equal(result.success, false, phase);
        assert.match(result.message, /Package removed by npm/);
        assert.match(result.message, new RegExp(`${phase} refused`));
        assert.equal(await readFile(manifest, "utf8"), original);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });
});
