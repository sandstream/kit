import { it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  symlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installInstallGateOpenCode, renderOpenCodeInstallGate } from "./agent-config.js";
import { generateKitCmdWrapper } from "./kit-wrapper.js";

async function withTempHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const prev = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const home = mkdtempSync(join(tmpdir(), "kit-home-"));
  process.env.HOME = home;
  if (process.platform === "win32") process.env.USERPROFILE = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
}

it("writes a tool.execute.before plugin that loads as a module, idempotently", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-ocgate-"));
  try {
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    const r1 = await installInstallGateOpenCode(dir);
    assert.equal(r1.action, "created");
    const pluginPath = join(dir, ".opencode", "plugin", "kit-install-gate.js");
    assert.ok(existsSync(pluginPath));
    const body = readFileSync(pluginPath, "utf-8");
    assert.equal(body, renderOpenCodeInstallGate(), "installer writes canonical template");
    assert.ok(body.includes("tool.execute.before"), "hooks the documented block point");
    assert.ok(body.includes("gate-bash"), "invokes kit gate-bash");
    // The generated plugin must be a loadable ESM module exporting the hook factory.
    const mod = await import(pathToFileURL(pluginPath).href);
    assert.equal(typeof mod.kitInstallGate, "function");
    const hooks = await mod.kitInstallGate();
    assert.equal(typeof hooks["tool.execute.before"], "function");
    // Non-bash tools are ignored (no spawn, no throw).
    await hooks["tool.execute.before"]({ tool: "read" }, { args: {} });
    assert.equal((await installInstallGateOpenCode(dir)).action, "unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it("detects an opencode.json project even without a .opencode dir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-ocgate2-"));
  try {
    writeFileSync(join(dir, "opencode.json"), "{}");
    assert.equal((await installInstallGateOpenCode(dir)).action, "created");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it("preserves the failed gate process as the blocking error cause", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-ocgate-cause-"));
  try {
    await withTempHome(async (home) => {
      mkdirSync(join(dir, ".opencode"), { recursive: true });
      const wrapper = join(home, ".kit", "bin", process.platform === "win32" ? "kit.cmd" : "kit");
      mkdirSync(join(wrapper, ".."), { recursive: true });
      if (process.platform === "win32") {
        writeFileSync(wrapper, "@echo off\r\necho fixture denied 1>&2\r\nexit /b 2\r\n");
      } else {
        writeFileSync(wrapper, '#!/bin/sh\nprintf "fixture denied\\n" >&2\nexit 2\n');
        chmodSync(wrapper, 0o755);
      }

      assert.equal((await installInstallGateOpenCode(dir)).action, "created");
      const pluginPath = join(dir, ".opencode", "plugin", "kit-install-gate.js");
      const mod = await import(pathToFileURL(pluginPath).href);
      const hooks = await mod.kitInstallGate();

      await assert.rejects(
        hooks["tool.execute.before"](
          { tool: "bash" },
          { args: { command: "npm install untriaged-package" } },
        ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /kit install-gate blocked: fixture denied/);
          assert.ok(error.cause instanceof Error, "blocking error retains subprocess failure");
          assert.match(
            String((error.cause as Error & { stderr?: Buffer }).stderr),
            /fixture denied/,
          );
          return true;
        },
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it(
  "runs native Windows OpenCode gate for allow and deny",
  { skip: process.platform !== "win32" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-ocgate-native-"));
    try {
      await withTempHome(async (home) => {
        assert.equal(homedir(), home);
        const wrapper = join(home, ".kit", "bin", "kit.cmd");
        mkdirSync(join(wrapper, ".."), { recursive: true });
        writeFileSync(
          wrapper,
          generateKitCmdWrapper({
            nodePath: process.execPath,
            cliPath: fileURLToPath(new URL("./cli.js", import.meta.url)),
          }),
        );
        mkdirSync(join(dir, ".opencode"));
        assert.equal((await installInstallGateOpenCode(dir)).action, "created");
        const mod = await import(
          pathToFileURL(join(dir, ".opencode", "plugin", "kit-install-gate.js")).href
        );
        const hooks = await mod.kitInstallGate();
        await assert.doesNotReject(
          hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "echo safe" } }),
        );
        await assert.rejects(
          hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "npm install" } }),
          /kit install-gate blocked/,
        );
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
it("updates stale kit-managed output but preserves an external gate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-ocgate-upgrade-"));
  try {
    const pluginPath = join(dir, ".opencode", "plugin", "kit-install-gate.js");
    mkdirSync(join(pluginPath, ".."), { recursive: true });
    writeFileSync(
      pluginPath,
      "// Generated by `kit agent-config --install-gate`. Delete this file to disable.\n// old gate-bash\n",
    );
    assert.equal((await installInstallGateOpenCode(dir)).action, "updated");
    assert.equal(readFileSync(pluginPath, "utf-8"), renderOpenCodeInstallGate());

    const external = "// external owner\n// custom gate-bash integration\n";
    writeFileSync(pluginPath, external);
    const result = await installInstallGateOpenCode(dir);
    assert.equal(result.action, "unchanged");
    assert.equal(result.detail, "external install-gate already wired");
    assert.equal(readFileSync(pluginPath, "utf-8"), external);

    const unrelated = "// operator-owned OpenCode plugin\nexport const keep = true;\n";
    writeFileSync(pluginPath, unrelated);
    const refused = await installInstallGateOpenCode(dir);
    assert.equal(refused.action, "skipped");
    assert.match(refused.detail ?? "", /external file.*refusing overwrite/);
    assert.equal(readFileSync(pluginPath, "utf-8"), unrelated);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it("refuses a symlinked OpenCode gate path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-ocgate-symlink-"));
  const outside = join(tmpdir(), `kit-ocgate-outside-${process.pid}`);
  try {
    mkdirSync(join(dir, ".opencode", "plugin"), { recursive: true });
    symlinkSync(outside, join(dir, ".opencode", "plugin", "kit-install-gate.js"));

    const result = await installInstallGateOpenCode(dir);

    assert.equal(result.action, "skipped");
    assert.match(result.detail ?? "", /symlinked path/);
    assert.equal(existsSync(outside), false, "dangling symlink target must not be created");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});
it("skips when no OpenCode project is present", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-ocgate3-"));
  try {
    assert.equal((await installInstallGateOpenCode(dir)).action, "skipped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
