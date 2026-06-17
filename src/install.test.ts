import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { installTools, miseErrorDetail, type InstallDeps } from "./install.js";

function makeDeps(overrides: Partial<InstallDeps> = {}): InstallDeps {
  return {
    checkTools: async () => [],
    miseInstall: async () => ({ ok: true, detail: "" }),
    ...overrides,
  };
}

describe("installTools", () => {
  it("returns already_ok for tools that pass checkTools", async () => {
    const deps = makeDeps({
      checkTools: async () => [
        { name: "node", required: "22", installed: "22.22.2", ok: true },
      ],
    });

    const results = await installTools({ node: "22" }, deps);

    assert.equal(results.length, 1);
    assert.equal(results[0].name, "node");
    assert.equal(results[0].action, "already_ok");
    assert.ok(results[0].detail.includes("22.22.2"));
  });

  it("calls mise and verifies after install", async () => {
    let callCount = 0;
    const installCalls: string[][] = [];

    const deps = makeDeps({
      checkTools: async () => {
        callCount++;
        if (callCount === 1) {
          return [{ name: "deno", required: "2", installed: null, ok: false }];
        }
        return [{ name: "deno", required: "2", installed: "2.1.0", ok: true }];
      },
      miseInstall: async (tool, version) => {
        installCalls.push([tool, version]);
        return { ok: true, detail: `Installed ${tool}@${version}` };
      },
    });

    const results = await installTools({ deno: "2" }, deps);

    assert.equal(results.length, 1);
    assert.equal(results[0].action, "installed");
    assert.ok(results[0].detail.includes("2.1.0"));
    assert.deepEqual(installCalls, [["deno", "2"]]);
  });

  it("returns failed when mise install throws", async () => {
    const deps = makeDeps({
      checkTools: async () => [
        { name: "bun", required: "1", installed: null, ok: false },
      ],
      miseInstall: async () => ({
        ok: false,
        detail: "mise: plugin not found",
      }),
    });

    const results = await installTools({ bun: "1" }, deps);

    assert.equal(results.length, 1);
    assert.equal(results[0].action, "failed");
    assert.ok(results[0].detail.includes("plugin not found"));
  });

  it("returns failed when post-install verification fails", async () => {
    let callCount = 0;
    const deps = makeDeps({
      checkTools: async () => {
        callCount++;
        if (callCount === 1) {
          return [{ name: "ruby", required: "3.2", installed: null, ok: false }];
        }
        return [{ name: "ruby", required: "3.2", installed: "3.1.4", ok: false }];
      },
      miseInstall: async () => ({ ok: true, detail: "installed" }),
    });

    const results = await installTools({ ruby: "3.2" }, deps);

    assert.equal(results.length, 1);
    assert.equal(results[0].action, "failed");
    assert.ok(results[0].detail.includes("3.1.4"));
    assert.ok(results[0].detail.includes("3.2"));
  });

  it("handles multiple tools with mixed results", async () => {
    let callCount = 0;
    const deps = makeDeps({
      checkTools: async (tools) => {
        callCount++;
        if (callCount === 1) {
          // Initial check: node ok, deno missing
          return [
            { name: "node", required: "22", installed: "22.22.2", ok: true },
            { name: "deno", required: "2", installed: null, ok: false },
          ];
        }
        // Post-install verification for deno
        return [{ name: "deno", required: "2", installed: "2.1.0", ok: true }];
      },
      miseInstall: async () => ({ ok: true, detail: "installed" }),
    });

    const results = await installTools({ node: "22", deno: "2" }, deps);

    assert.equal(results.length, 2);
    assert.equal(results[0].action, "already_ok");
    assert.equal(results[1].action, "installed");
  });
});

describe("miseErrorDetail", () => {
  it("turns a missing-mise spawn error into an actionable message", () => {
    const detail = miseErrorDetail("spawn mise ENOENT");
    assert.ok(/mise is not installed/i.test(detail));
    assert.ok(/brew install mise|mise\.run/i.test(detail));
  });

  it("passes other errors through (first line only)", () => {
    assert.equal(miseErrorDetail("mise: plugin not found\nmore noise"), "mise: plugin not found");
  });
});
