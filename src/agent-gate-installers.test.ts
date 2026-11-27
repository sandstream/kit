/**
 * The install gate as each agent runs it. Each test installs the gate with kit's installer, runs
 * what was installed (hook file, hook line or plugin module) with the agent's payload, and reads
 * the result the way the agent's source does. Sources, at a fixed commit:
 * - Cline: github.com/cline/cline cbc7d141. VS Code payload `apps/vscode/src/sdk/hooks-adapter.ts:168-174`
 *   (non-string values JSON-stringified, `:28-38`); CLI payload `sdk/packages/core/src/hooks/hook-file-hooks.ts:845-867`;
 *   `cancel: true` blocks (`apps/vscode/src/core/hooks/hook-factory.ts:469-513`).
 * - Gemini CLI: github.com/google-gemini/gemini-cli 60f8082b. Payload `packages/core/src/hooks/hookEventHandler.ts:76-93,371-385`;
 *   reading `packages/core/src/hooks/hookRunner.ts:451-489,537-560`.
 * - Antigravity: https://antigravity.google/docs/hooks.md (fetched 2026-11-26; closed source).
 * - OpenCode: github.com/sst/opencode, loaders cited in opencode-gate.ts.
 * The npm registry is unreachable on purpose, so `npm i some-untriaged-pkg` is blocked offline.
 * No test starts a real agent.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ANTIGRAVITY_HOOK_NAME,
  GEMINI_TRUST_NOTICE,
  installInstallGateAntigravity,
  installInstallGateCline,
  installInstallGateGemini,
  installInstallGateOpenCode,
} from "./agent-config.js";
import { generateKitCmdWrapper } from "./kit-wrapper.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
const POSIX = process.platform !== "win32";
const NO_SH = POSIX ? false : "the installed hook line is POSIX sh; the CLI tests cover Windows";
const INSTALL = "npm i some-untriaged-pkg";
const SAFE = "ls";
const OFFLINE = { KIT_NPM_REGISTRY: "http://127.0.0.1:9", KIT_OSV_API: "http://127.0.0.1:9" };

let home = "";
const saved = { ...process.env };
const env = (): NodeJS.ProcessEnv => ({
  ...process.env,
  ...OFFLINE,
  HOME: home,
  USERPROFILE: home,
  KIT_NO_UPDATE_CHECK: "1",
  KIT_HIDE_HOOK_SKIP_BANNER: "1",
});

before(() => {
  // kit's wrapper in a temp home, so installers write the line a person's machine gets.
  home = mkdtempSync(join(tmpdir(), "kit-agent-gates-home-"));
  const bin = join(home, ".kit", "bin");
  mkdirSync(bin, { recursive: true });
  if (POSIX) {
    writeFileSync(join(bin, "kit"), `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`);
    chmodSync(join(bin, "kit"), 0o755);
  } else {
    const cmd = generateKitCmdWrapper({ nodePath: process.execPath, cliPath: cli });
    writeFileSync(join(bin, "kit.cmd"), cmd);
  }
  Object.assign(process.env, OFFLINE, { HOME: home }, POSIX ? {} : { USERPROFILE: home });
});
after(() => {
  for (const k of ["HOME", "USERPROFILE", ...Object.keys(OFFLINE)]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmTemp(home);
});

function project(t: { after: (fn: () => void) => void }, marker: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-agent-gates-"));
  t.after(() => rmTemp(dir));
  mkdirSync(join(dir, marker), { recursive: true });
  return dir;
}
const run = (file: string, args: string[], cwd: string, payload: unknown) =>
  spawnSync(file, args, { cwd, input: JSON.stringify(payload), encoding: "utf8", env: env() });
const gate = (cwd: string, payload: unknown, format: string) =>
  run(process.execPath, [cli, "gate-bash", "--format", format], cwd, payload);
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const lastJson = (stdout: string): Record<string, unknown> => {
  try {
    return JSON.parse(stdout.trim().split("\n").pop() ?? "");
  } catch {
    return {};
  }
};
type Result = ReturnType<typeof run>;

/** Gemini's reading: JSON on stdout (else stderr) decides; plain text blocks only from exit 2. */
function geminiDenies(r: Result): boolean {
  const text = r.stdout.trim() || r.stderr.trim();
  if (!text) return false;
  try {
    const d = (JSON.parse(text) as { decision?: unknown }).decision;
    return d === "deny" || d === "block";
  } catch {
    return (r.status ?? 0) >= 2;
  }
}

const clineVsCode = (commands: unknown) => ({
  taskId: "t",
  preToolUse: { toolName: "run_commands", parameters: { commands: JSON.stringify(commands) } },
});
const clineCli = (input: Record<string, unknown>, name = "run_commands") => ({
  hookName: "tool_call",
  taskId: "t",
  sessionContext: { rootSessionId: "t" },
  iteration: 3,
  tool_call: { id: "call-1", name, input },
  preToolUse: { toolName: name, parameters: {} },
});
const gemini = (command: string) => ({
  session_id: "s",
  hook_event_name: "BeforeTool",
  tool_name: "run_shell_command",
  tool_input: { command, description: "run" },
});
const antigravity = (command: string) => ({
  toolCall: { name: "run_command", args: { CommandLine: command, Cwd: "/w" } },
  conversationId: "c",
});
const sh = (dir: string, line: string, payload: unknown) =>
  run("/bin/sh", ["-c", line], dir, payload);

/** The hook line (or file) each installer writes, and how the agent reads one run of it. */
const HOOKS = [
  {
    agent: "Cline",
    marker: ".clinerules",
    install: installInstallGateCline,
    run: (dir: string, payload: unknown) =>
      run(join(dir, ".clinerules", "hooks", "PreToolUse"), [], dir, payload),
    payload: (cmd: string) => clineVsCode([SAFE, cmd]),
    blocks: (r: Result) => lastJson(r.stdout).cancel === true,
  },
  {
    agent: "Gemini CLI",
    marker: ".gemini",
    install: installInstallGateGemini,
    run: (dir: string, payload: unknown) =>
      sh(
        dir,
        json(join(dir, ".gemini", "settings.json")).hooks.BeforeTool[0].hooks[0].command,
        payload,
      ),
    payload: gemini,
    blocks: (r: Result) =>
      geminiDenies(r) && lastJson(r.stdout).decision === "deny" && r.status === 2,
  },
  {
    agent: "Antigravity",
    marker: ".agents",
    install: installInstallGateAntigravity,
    run: (dir: string, payload: unknown) =>
      sh(
        dir,
        json(join(dir, ".agents", "hooks.json"))[ANTIGRAVITY_HOOK_NAME].PreToolUse[0].hooks[0]
          .command,
        payload,
      ),
    payload: antigravity,
    blocks: (r: Result) => lastJson(r.stdout).decision === "deny" && r.status === 2,
  },
];

describe("the installed hook blocks an install and allows ls", { skip: NO_SH }, () => {
  for (const h of HOOKS) {
    it(h.agent, async (t) => {
      const dir = project(t, h.marker);
      assert.equal((await h.install(dir)).action, "created");
      const deny = h.run(dir, h.payload(INSTALL));
      assert.ok(h.blocks(deny), deny.stdout + deny.stderr);
      const allow = h.run(dir, h.payload(SAFE));
      assert.ok(!h.blocks(allow) && allow.status === 0, allow.stdout + allow.stderr);
    });
  }
});

describe("Cline run_commands: what kit gates", () => {
  const shc = (cmd: string) => ({ command: "sh", args: ["-c", cmd] });
  const echo = { command: "echo", args: [`; ${INSTALL}`] };
  const patch = { name: "apply_patch", input: `+${INSTALL}` };
  const CASES: [string, unknown, boolean][] = [
    ["CLI tool_call.input list", clineCli({ commands: [SAFE, INSTALL] }), true],
    ["VS Code list, safe", clineVsCode([SAFE, "pwd"]), false],
    // Structured entries run without a shell (schemas.ts:133-142): each argv word stays one word.
    ["an argument that hides an install", clineCli({ commands: [shc(INSTALL)] }), true],
    ["an argument that only looks like one", clineCli({ commands: [echo] }), false],
    [
      "args that are not strings",
      clineCli({ commands: [{ command: "npm", args: ["i", 1] }] }),
      true,
    ],
    ["args that are not a list", clineVsCode([{ command: "npm", args: "i x" }]), true],
    [
      "legacy command",
      { preToolUse: { toolName: "execute_command", parameters: { command: INSTALL } } },
      true,
    ],
    ["no readable command", { preToolUse: { toolName: "run_commands", parameters: {} } }, true],
    [
      "a patch sent as a bare string",
      { tool_call: patch, preToolUse: { toolName: patch.name } },
      false,
    ],
  ];
  for (const [name, payload, blocked] of CASES) {
    it(`${blocked ? "blocks" : "allows"}: ${name}`, (t) => {
      const r = gate(project(t, ".clinerules"), payload, "cline");
      assert.equal(lastJson(r.stdout).cancel === true, blocked, r.stdout + r.stderr);
    });
  }

  it("gates the list as one script too: a cd in one command moves the next", (t) => {
    const dir = project(t, ".clinerules");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "package.json"), '{"dependencies":{"some-untriaged-pkg":"1"}}');
    for (const alone of ["cd sub", "npm install"]) {
      const r = gate(dir, clineVsCode([alone]), "cline");
      assert.notEqual(lastJson(r.stdout).cancel, true, `${alone} alone: ${r.stdout}`);
    }
    const both = gate(dir, clineVsCode(["cd sub", "npm install"]), "cline");
    assert.equal(lastJson(both.stdout).cancel, true, both.stdout + both.stderr);
  });
});

describe("Gemini CLI", () => {
  it("--format gemini puts the decision on stdout and exits 2 (all platforms)", (t) => {
    const dir = project(t, ".gemini");
    const deny = gate(dir, gemini(INSTALL), "gemini");
    assert.equal(lastJson(deny.stdout).decision, "deny", deny.stdout + deny.stderr);
    assert.equal(deny.status, 2);
    assert.ok(!geminiDenies(gate(dir, gemini(SAFE), "gemini")));
  });

  it("refreshes an older kit line in place and says the folder must be trusted", async (t) => {
    const dir = project(t, ".gemini");
    const path = join(dir, ".gemini", "settings.json");
    const group = { matcher: "", hooks: [{ type: "command", command: "kit gate-bash" }] };
    writeFileSync(path, JSON.stringify({ theme: "x", hooks: { BeforeTool: [group] } }));
    const r = await installInstallGateGemini(dir);
    assert.equal(r.action, "updated");
    assert.equal(r.notice, GEMINI_TRUST_NOTICE);
    assert.match(GEMINI_TRUST_NOTICE, /trusted folder.*\/permissions trust/);
    const s = json(path);
    assert.equal(s.theme, "x");
    assert.equal(s.hooks.BeforeTool.length, 1);
    assert.equal(s.hooks.BeforeTool[0].hooks.length, 1);
    assert.ok(s.hooks.BeforeTool[0].hooks[0].command.endsWith("gate-bash --format gemini"));
    assert.equal((await installInstallGateGemini(dir)).action, "unchanged");
  });

  it("kit agent-config prints the trust step", { skip: NO_SH }, (t) => {
    const dir = project(t, ".gemini");
    writeFileSync(join(dir, ".kit.toml"), "version = 1\n");
    const r = run(process.execPath, [cli, "agent-config"], dir, {});
    assert.ok(r.stdout.includes(GEMINI_TRUST_NOTICE), r.stdout + r.stderr);
  });
});

describe("Antigravity: hooks.json is keyed by hook name", () => {
  const kitGroup = {
    matcher: "run_command",
    hooks: [{ type: "command", command: "kit gate-bash" }],
  };
  const user = { matcher: "view_file", hooks: [{ type: "command", command: "./audit.sh" }] };
  const mine = { enabled: true, PreToolUse: [user] };
  const CASES: [string, unknown, (cfg: Record<string, unknown>) => void][] = [
    [
      "a new file holds only kit's entry",
      undefined,
      (cfg) => assert.deepEqual(Object.keys(cfg), [ANTIGRAVITY_HOOK_NAME]),
    ],
    [
      "kit leaves the old {hooks} entry, user hooks stay",
      { hooks: { PreToolUse: [kitGroup, user], PostToolUse: [user] }, mine },
      (cfg) =>
        assert.deepEqual(
          [cfg.hooks, cfg.mine],
          [{ PreToolUse: [user], PostToolUse: [user] }, mine],
        ),
    ],
    [
      "an old entry with only kit's gate goes",
      { hooks: { PreToolUse: [kitGroup] } },
      (cfg) => assert.equal(cfg.hooks, undefined),
    ],
  ];
  for (const [name, old, check] of CASES) {
    it(name, async (t) => {
      const dir = project(t, ".agents");
      const path = join(dir, ".agents", "hooks.json");
      if (old) writeFileSync(path, JSON.stringify(old));
      assert.equal((await installInstallGateAntigravity(dir)).action, old ? "updated" : "created");
      const cfg = json(path);
      check(cfg);
      const kit = cfg[ANTIGRAVITY_HOOK_NAME];
      assert.equal(kit.enabled, true);
      assert.equal(kit.PreToolUse.length, 1);
      assert.ok(kit.PreToolUse[0].hooks[0].command.endsWith("gate-bash --format antigravity"));
      assert.equal((await installInstallGateAntigravity(dir)).action, "unchanged");
    });
  }

  it("refuses to overwrite a hooks.json it cannot parse", async (t) => {
    const dir = project(t, ".agents");
    writeFileSync(join(dir, ".agents", "hooks.json"), "{ not json");
    assert.equal((await installInstallGateAntigravity(dir)).action, "failed");
    assert.equal(readFileSync(join(dir, ".agents", "hooks.json"), "utf8"), "{ not json");
  });
});

describe("OpenCode: the plugin form follows the installed version", () => {
  type Hooks = Record<string, (i: unknown, o: unknown) => Promise<void>>;
  type Mod = Record<string, unknown> & { default?: Record<string, unknown> };
  const load = async (dir: string, tag: string): Promise<Mod> =>
    import(`${pathToFileURL(join(dir, ".opencode", "plugin", "kit-install-gate.js")).href}?${tag}`);
  /** 1.0-1.3 call every export as a function (index.ts:41-44 at v1.0.0). */
  const v1Hooks = async (mod: Mod): Promise<Hooks> => {
    const fns = [...new Set(Object.values(mod))];
    assert.ok(
      fns.every((fn) => typeof fn === "function"),
      "OpenCode 1.0-1.3 call every export",
    );
    return (await (fns[0] as () => Promise<Hooks>)()) as Hooks;
  };
  /** 1.4+: a default object with id and server (shared.ts:272-303 at v1.19.6). */
  const v14Hooks = async (mod: Mod): Promise<Hooks> => {
    assert.equal(typeof mod.default?.id, "string");
    return (await (mod.default?.server as () => Promise<Hooks>)()) as Hooks;
  };
  /** 2.x: a default object with a string id and setup (module.ts:81-93); one event per call. */
  const v2Shell = async (mod: Mod) => {
    assert.ok(mod.default && typeof mod.default === "object" && typeof mod.default.id === "string");
    let hook: ((e: unknown) => Promise<void>) | undefined;
    const register = async (_n: string, cb: (e: unknown) => Promise<void>) => void (hook = cb);
    await (mod.default.setup as (c: unknown) => Promise<void>)({ tool: { hook: register } });
    return (cmd: string) =>
      hook!({ tool: "shell", sessionID: "s", id: "c", input: { command: cmd } });
  };
  const blocksV1 = async (hooks: Hooks) => {
    const call = (command: string) =>
      hooks["tool.execute.before"]({ tool: "bash" }, { args: { command } });
    await assert.rejects(call(INSTALL), /kit install-gate blocked/);
    await assert.doesNotReject(call(SAFE));
  };

  it("2.4.1 and 1.19.6 get the default-object plugin, and both loaders block", async (t) => {
    for (const version of ["2.4.1", "opencode 1.19.6\n"]) {
      const dir = project(t, ".opencode");
      assert.equal((await installInstallGateOpenCode(dir, () => version)).action, "created");
      const mod = await load(dir, version.trim());
      const shell = await v2Shell(mod);
      await assert.rejects(shell(INSTALL), /kit install-gate blocked: .*some-untriaged-pkg/s);
      await assert.doesNotReject(shell(SAFE));
      await blocksV1(await v14Hooks(mod));
    }
  });

  it("1.3.0 gets function exports only, which its loader can call", async (t) => {
    const dir = project(t, ".opencode");
    await installInstallGateOpenCode(dir, () => "1.3.0");
    await blocksV1(await v1Hooks(await load(dir, "v13")));
    // A later run that finds OpenCode 2 upgrades it in place.
    assert.equal((await installInstallGateOpenCode(dir, () => "2.4.1")).action, "updated");
    assert.equal(typeof (await load(dir, "v2")).default, "object");
  });

  it("keeps kit's 1.x plugin when the version cannot be read, and says so", async (t) => {
    const dir = project(t, ".opencode");
    await installInstallGateOpenCode(dir, () => "1.2.0");
    const r = await installInstallGateOpenCode(dir, () => undefined);
    assert.equal(r.action, "unchanged");
    assert.match(r.notice ?? "", /could not read the OpenCode version.*2\.x does not load/s);
    assert.equal(typeof (await load(dir, "kept")).default, "undefined");
    const n = await installInstallGateOpenCode(project(t, ".opencode"), () => undefined);
    assert.equal(n.action, "created");
    assert.match(n.notice ?? "", /1\.4 and later/);
  });
});
