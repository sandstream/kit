import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  installPlugin,
  getPluginInfo,
  type PluginInstallDeps,
  type PluginMetadata,
} from "./plugins.js";
import { loadPluginAdapters } from "./plugin-loader.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const metadata: PluginMetadata = {
  name: "fixture",
  description: "fixture",
  version: "1.2.3",
  author: "test",
  license: "MIT",
  repository: "https://example.invalid/fixture",
  package: "kit-plugin-fixture",
  kitVersion: ">=6",
  tags: ["test"],
  install: "npm install kit-plugin-fixture@1.2.3",
};

describe("installPlugin supply-chain gate", () => {
  it("blocks npm when triage does not pass", async () => {
    const events: string[] = [];
    const deps: PluginInstallDeps = {
      gateInstall: async (tool) => {
        events.push(`triage:${tool}`);
        return { decision: "blocked", reason: "fixture refused", tool };
      },
      exec: async (command, args) => {
        events.push(`${command}:${args.join(" ")}`);
        return { stdout: "", stderr: "" };
      },
    };
    const result = await installPlugin("fixture", metadata, deps);

    assert.equal(result.success, false);
    assert.match(result.message, /triage.*fixture refused/i);
    assert.deepEqual(events, ["triage:npm:kit-plugin-fixture@1.2.3"]);
  });

  it("installs exactly the package spec that passed triage", async () => {
    const events: string[] = [];
    const deps: PluginInstallDeps = {
      gateInstall: async (tool) => {
        events.push(`triage:${tool}`);
        return { decision: "pass", reason: "fixture passed", tool };
      },
      exec: async (command, args) => {
        events.push(`${command}:${args.join(" ")}`);
        return { stdout: "", stderr: "" };
      },
    };
    const result = await installPlugin("fixture", metadata, deps);

    assert.equal(result.success, true);
    assert.deepEqual(events, [
      "triage:npm:kit-plugin-fixture@1.2.3",
      "npm:install --save-exact kit-plugin-fixture@1.2.3",
    ]);
  });

  it("pins a registry entry that prints an unversioned install command", async () => {
    const events: string[] = [];
    const deps: PluginInstallDeps = {
      gateInstall: async (tool) => {
        events.push(`triage:${tool}`);
        return { decision: "pass", reason: "fixture passed", tool };
      },
      exec: async (command, args) => {
        events.push(`${command}:${args.join(" ")}`);
        return { stdout: "", stderr: "" };
      },
    };
    const result = await installPlugin(
      "fixture",
      { ...metadata, install: "npm install kit-plugin-fixture" },
      deps,
    );
    assert.equal(result.success, true);
    assert.deepEqual(events, [
      "triage:npm:kit-plugin-fixture@1.2.3",
      "npm:install --save-exact kit-plugin-fixture@1.2.3",
    ]);
  });
});

describe("installPlugin registry integrity", () => {
  it("rejects a printed install command for a different package or version", async () => {
    const deps: PluginInstallDeps = {
      gateInstall: async () => {
        throw new Error("triage should not run");
      },
      exec: async () => {
        throw new Error("npm should not run");
      },
    };
    for (const install of [
      "npm install kit-plugin-other@1.2.3",
      "npm install kit-plugin-fixture@1.2.4",
    ]) {
      const result = await installPlugin("fixture", { ...metadata, install }, deps);
      assert.equal(result.success, false);
      assert.match(result.message, /registry install spec/i);
    }
  });

  it("rejects npm flags and non-registry package specs before triage", async () => {
    for (const target of ["--global", "file:../plugin", "https://example.invalid/plugin.tgz"]) {
      const events: string[] = [];
      const deps: PluginInstallDeps = {
        gateInstall: async (tool) => {
          events.push(`triage:${tool}`);
          return { decision: "pass", reason: "fixture passed", tool };
        },
        exec: async (command, args) => {
          events.push(`${command}:${args.join(" ")}`);
          return { stdout: "", stderr: "" };
        },
      };
      const result = await installPlugin(
        "fixture",
        { ...metadata, package: target, install: `npm install ${target}` },
        deps,
      );

      assert.equal(result.success, false);
      assert.match(result.message, /refusing non-registry/i);
      assert.deepEqual(events, []);
    }
  });
});

describe("installPlugin adapter registration", () => {
  it("registers an installed adapter once without losing other package fields", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kit-plugin-install-"));
    const manifest = join(cwd, "package.json");
    try {
      await writeFile(
        manifest,
        JSON.stringify({
          name: "app",
          kitPlugins: ["kit-plugin-existing"],
          scripts: { test: "node --test" },
        }) + "\n",
      );
      const deps: PluginInstallDeps = {
        gateInstall: async (tool) => ({ decision: "pass", reason: "fixture passed", tool }),
        exec: async () => ({ stdout: "", stderr: "" }),
      };
      const adapterMetadata = { ...metadata, adapter: "fixture/deploy" };
      const first = await installPlugin("fixture", adapterMetadata, deps, cwd);
      const second = await installPlugin("fixture", adapterMetadata, deps, cwd);
      assert.equal(first.success, true);
      assert.equal(second.success, true);
      const pkg = JSON.parse(await readFile(manifest, "utf8")) as Record<string, unknown>;
      assert.deepEqual(pkg.kitPlugins, ["kit-plugin-existing", "kit-plugin-fixture"]);
      assert.deepEqual(pkg.scripts, { test: "node --test" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not register API-only packages as adapters", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kit-plugin-api-"));
    const manifest = join(cwd, "package.json");
    try {
      await writeFile(manifest, JSON.stringify({ name: "app" }) + "\n");
      const deps: PluginInstallDeps = {
        gateInstall: async (tool) => ({ decision: "pass", reason: "fixture passed", tool }),
        exec: async () => ({ stdout: "", stderr: "" }),
      };
      const result = await installPlugin("fixture", { ...metadata, adapter: undefined }, deps, cwd);
      assert.equal(result.success, true);
      assert.match(result.message, /package API/i);
      assert.equal(JSON.parse(await readFile(manifest, "utf8")).kitPlugins, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("requires a project manifest before installing an adapter", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kit-plugin-no-project-"));
    const events: string[] = [];
    try {
      const deps: PluginInstallDeps = {
        gateInstall: async (tool) => {
          events.push("triage");
          return { decision: "pass", reason: "fixture passed", tool };
        },
        exec: async () => {
          events.push("npm");
          return { stdout: "", stderr: "" };
        },
      };
      const result = await installPlugin(
        "fixture",
        { ...metadata, adapter: "fixture/deploy" },
        deps,
        cwd,
      );
      assert.equal(result.success, false);
      assert.match(result.message, /project package\.json.*npm init/i);
      assert.deepEqual(events, []);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("installPlugin real adapter integration", () => {
  it("installs and registers the real Railway adapter so kit can load it", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kit-railway-install-"));
    const metadata = getPluginInfo("railway");
    assert.ok(metadata?.adapter);
    try {
      await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "app" }) + "\n");
      const deps: PluginInstallDeps = {
        gateInstall: async (tool) => ({ decision: "pass", reason: "fixture passed", tool }),
        exec: async (command, args) => {
          assert.equal(command, "npm");
          assert.deepEqual(args, [
            "install",
            "--save-exact",
            `${metadata.package}@${metadata.version}`,
          ]);
          const installed = join(cwd, "node_modules", metadata.package!);
          await mkdir(installed, { recursive: true });
          const source = join(repoRoot, "packages", "kit-plugin-railway");
          await cp(join(source, "dist"), join(installed, "dist"), { recursive: true });
          await cp(join(source, "package.json"), join(installed, "package.json"));
          return { stdout: "", stderr: "" };
        },
      };
      const result = await installPlugin("railway", metadata, deps, cwd);
      assert.equal(result.success, true);
      const registry = await loadPluginAdapters(cwd);
      assert.equal(typeof registry["railway/deploy"]?.provision, "function");
      assert.deepEqual(JSON.parse(await readFile(join(cwd, "package.json"), "utf8")).kitPlugins, [
        metadata.package,
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
