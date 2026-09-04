import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { installPlugin, type PluginInstallDeps, type PluginMetadata } from "./plugins.js";

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
      "npm:install kit-plugin-fixture@1.2.3",
    ]);
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
