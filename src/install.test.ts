import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installTools,
  ensureScannersInstalled,
  miseErrorDetail,
  miseInstall,
  miseUseTarget,
  type InstallDeps,
  type MiseExecDeps,
} from "./install.js";

function makeDeps(overrides: Partial<InstallDeps> = {}): InstallDeps {
  return {
    checkTools: async () => [],
    miseInstall: async () => ({ ok: true, detail: "" }),
    gateInstall: async (tool) => ({ tool, decision: "pass", reason: "stub" }),
    resolveVersion: async (_tool, version) => ({ kind: "passthrough", version }),
    ...overrides,
  };
}

describe("installTools", () => {
  it("returns already_ok for tools that pass checkTools", async () => {
    const deps = makeDeps({
      checkTools: async () => [{ name: "node", required: "22", installed: "22.22.2", ok: true }],
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
      checkTools: async () => [{ name: "bun", required: "1", installed: null, ok: false }],
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
      checkTools: async () => {
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

  it("triage-blocked tool is NOT installed (watertight gate)", async () => {
    let miseCalled = false;
    const deps = makeDeps({
      checkTools: async () => [
        { name: "aqua:aquasecurity/trivy", required: "latest", installed: null, ok: false },
      ],
      gateInstall: async (tool) => ({
        tool,
        decision: "blocked",
        reason: "triage did not pass (repo ...): typosquat",
      }),
      miseInstall: async () => {
        miseCalled = true;
        return { ok: true, detail: "installed" };
      },
    });

    const results = await installTools({ "aqua:aquasecurity/trivy": "latest" }, deps);

    assert.equal(results[0].action, "blocked");
    assert.match(results[0].detail, /typosquat/);
    assert.equal(miseCalled, false); // gate blocked before mise ran
  });

  it("skipTriage bypasses the gate (elevation-gated override path)", async () => {
    let gateCalled = false;
    const deps = makeDeps({
      checkTools: async (tools) =>
        Object.keys(tools).map((name) => ({
          name,
          required: "latest",
          installed: null,
          ok: false,
        })),
      gateInstall: async (tool) => {
        gateCalled = true;
        return { tool, decision: "blocked", reason: "would block" };
      },
      miseInstall: async () => ({ ok: true, detail: "installed" }),
    });

    const results = await installTools({ "aqua:x/y": "latest" }, deps, { skipTriage: true });

    assert.equal(gateCalled, false); // gate skipped entirely
    // post-install verify re-checks; with stub checkTools it stays not-ok → failed, but mise DID run
    assert.notEqual(results[0].action, "blocked");
  });
});

describe("ensureScannersInstalled (self-healing check preflight)", () => {
  it("returns [] when disabled, air-gapped, or no tools (no install attempted)", async () => {
    let checked = false;
    const deps = makeDeps({
      checkTools: async () => {
        checked = true;
        return [];
      },
    });
    assert.deepEqual(
      await ensureScannersInstalled({ semgrep: "latest" }, { disabled: true }, deps),
      [],
    );
    assert.deepEqual(
      await ensureScannersInstalled({ semgrep: "latest" }, { airGapped: true }, deps),
      [],
    );
    assert.deepEqual(await ensureScannersInstalled(undefined, {}, deps), []);
    assert.equal(checked, false, "no gating path should have touched checkTools");
  });

  it("installs ONLY declared scanner refs — never other project tools", async () => {
    const seen = new Set<string>();
    const deps = makeDeps({
      checkTools: async (tools) => {
        for (const k of Object.keys(tools)) seen.add(k);
        return Object.keys(tools).map((name) => ({
          name,
          required: "latest",
          installed: null,
          ok: false,
        }));
      },
      miseInstall: async () => ({ ok: true, detail: "installed" }),
    });
    await ensureScannersInstalled(
      {
        node: "22", // not a scanner → must be ignored
        semgrep: "latest", // scanner
        "aqua:aquasecurity/trivy": "latest", // scanner
        "some/random-tool": "1", // not a scanner → ignored
      },
      {},
      deps,
    );
    assert.deepEqual(
      [...seen].sort(),
      ["aqua:aquasecurity/trivy", "semgrep"],
      "only known scanner refs reach installTools",
    );
  });

  it("returns [] when the project declares no scanner tools", async () => {
    const deps = makeDeps({
      checkTools: async () => {
        throw new Error("should not be called — nothing to install");
      },
    });
    assert.deepEqual(await ensureScannersInstalled({ node: "22", python: "3.12" }, {}, deps), []);
  });

  it("is triage-gated: a blocked scanner is not installed (inherits installTools)", async () => {
    let miseCalled = false;
    const deps = makeDeps({
      checkTools: async () => [
        { name: "aqua:aquasecurity/trivy", required: "latest", installed: null, ok: false },
      ],
      gateInstall: async (tool) => ({ tool, decision: "blocked", reason: "typosquat" }),
      miseInstall: async () => {
        miseCalled = true;
        return { ok: true, detail: "installed" };
      },
    });
    const results = await ensureScannersInstalled(
      { "aqua:aquasecurity/trivy": "latest" },
      {},
      deps,
    );
    assert.equal(results[0]?.action, "blocked");
    assert.equal(miseCalled, false);
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

  it("detects an untrusted .mise.toml from stderr and points at mise trust", () => {
    const stderr =
      "mise ERROR Config files in ~/repo/.mise.toml are not trusted.\nmise ERROR Trust them with `mise trust`.";
    const detail = miseErrorDetail("Command failed: mise install node@24", stderr);
    assert.ok(/not trusted/i.test(detail));
    assert.ok(/mise trust/.test(detail));
  });

  it("surfaces the real mise ERROR line instead of the generic Command failed", () => {
    const stderr =
      "mise ERROR error parsing config file: ~/repo/.mise.toml\nmise ERROR Version: 2026.6.11";
    const detail = miseErrorDetail("Command failed: mise install node@24", stderr);
    assert.equal(detail, "error parsing config file: ~/repo/.mise.toml");
  });
});

describe("installTools read-only mode", () => {
  it("refuses without touching any dep when KIT_READ_ONLY=1", async () => {
    let touched = false;
    const deps = makeDeps({
      checkTools: async () => {
        touched = true;
        return [{ name: "deno", required: "2", installed: null, ok: false }];
      },
      miseInstall: async () => {
        touched = true;
        return { ok: true, detail: "" };
      },
    });
    process.env.KIT_READ_ONLY = "1";
    try {
      const results = await installTools({ deno: "2" }, deps);
      assert.equal(results.length, 1);
      assert.equal(results[0].action, "blocked");
      assert.match(results[0].detail, /read-only mode active/);
      assert.equal(touched, false); // no check / no install ran
    } finally {
      delete process.env.KIT_READ_ONLY;
    }
  });
});

describe("installTools never hands latest to mise for npm/pipx (fork-loop fix)", () => {
  const missing = async (tools: Record<string, string>) =>
    Object.keys(tools).map((name) => ({ name, required: "latest", installed: null, ok: false }));

  it("installs the resolved cooled version and triages that exact version", async () => {
    const installs: string[][] = [];
    const gated: string[] = [];
    const deps = makeDeps({
      checkTools: missing,
      resolveVersion: async () => ({ kind: "resolved", version: "1.1305.1", detail: "cooled" }),
      gateInstall: async (tool) => {
        gated.push(tool);
        return { tool, decision: "pass", reason: "ok" };
      },
      miseInstall: async (tool, version) => {
        installs.push([tool, version]);
        return { ok: true, detail: "" };
      },
    });
    await installTools({ "npm:snyk": "latest" }, deps);
    assert.deepEqual(installs, [["npm:snyk", "1.1305.1"]]);
    assert.deepEqual(gated, ["npm:snyk@1.1305.1"]);
  });

  it("refuses (fail closed) when latest cannot be resolved: no gate, no mise", async () => {
    let touched = false;
    const deps = makeDeps({
      checkTools: missing,
      resolveVersion: async () => ({ kind: "refused", reason: "registry could not be read" }),
      gateInstall: async (tool) => {
        touched = true;
        return { tool, decision: "pass", reason: "ok" };
      },
      miseInstall: async () => {
        touched = true;
        return { ok: true, detail: "" };
      },
    });
    const [r] = await installTools({ "npm:@socketsecurity/cli": "latest" }, deps);
    assert.equal(r.action, "failed");
    assert.match(r.detail, /registry could not be read/);
    assert.equal(touched, false);
  });
});

/** A fake exec that records every call. No test here spawns mise. */
function fakeMise(dir: string, home: string, fail = false) {
  const calls: string[][] = [];
  const deps: MiseExecDeps = {
    exec: async (file, args) => {
      calls.push([file, ...args]);
      if (fail) throw Object.assign(new Error("Command failed"), { stderr: "mise ERROR boom" });
      return { stdout: "", stderr: "" };
    },
    cwd: () => dir,
    home: () => home,
  };
  return { calls, deps };
}

describe("miseInstall writes only to the project's mise config", () => {
  function tmp(): string {
    return mkdtempSync(join(tmpdir(), "kit-mise-install-"));
  }

  it("passes --path <project>/mise.toml to mise use, with the exact version", async () => {
    const dir = tmp();
    const home = tmp();
    try {
      const { calls, deps } = fakeMise(dir, home);
      const r = await miseInstall("npm:snyk", "1.1305.1", deps);
      assert.equal(r.ok, true);
      assert.deepEqual(calls, [
        ["mise", "install", "npm:snyk@1.1305.1"],
        ["mise", "use", "--path", join(dir, "mise.toml"), "npm:snyk@1.1305.1"],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("uses an existing .mise.toml rather than creating a second file", () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, ".mise.toml"), "[tools]\n");
      assert.equal(miseUseTarget(dir, join(dir, "elsewhere")), join(dir, ".mise.toml"));
      writeFileSync(join(dir, "mise.toml"), "[tools]\n");
      assert.equal(miseUseTarget(dir, join(dir, "elsewhere")), join(dir, "mise.toml"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses in the home directory, where mise use would write the global config", async () => {
    const home = tmp();
    try {
      mkdirSync(join(home, ".config"), { recursive: true });
      const { calls, deps } = fakeMise(home, home);
      const r = await miseInstall("npm:snyk", "1.1305.1", deps);
      assert.equal(r.ok, false);
      assert.match(r.detail, /global mise config/);
      assert.equal(calls.length, 0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses latest for an npm: or pipx: tool even when a caller passes it directly", async () => {
    const dir = tmp();
    try {
      const { calls, deps } = fakeMise(dir, join(dir, "home"));
      for (const tool of ["npm:snyk", "pipx:semgrep"]) {
        const r = await miseInstall(tool, "latest", deps);
        assert.equal(r.ok, false);
        assert.match(r.detail, /never hands "latest" to mise/);
      }
      assert.equal(calls.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("turns a mise failure into its ERROR line", async () => {
    const dir = tmp();
    try {
      const { deps } = fakeMise(dir, join(dir, "home"), true);
      const r = await miseInstall("aqua:x/y", "1.0.0", deps);
      assert.equal(r.ok, false);
      assert.equal(r.detail, "boom");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
