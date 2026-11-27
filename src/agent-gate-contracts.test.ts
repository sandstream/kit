/**
 * The install gate as each agent runs it. Every test installs the gate with kit's own installer,
 * then runs what was installed (the hook file, the hook command line or the plugin module) with the
 * agent's real payload shape, and reads the result the way the agent's source does. The payloads
 * and the reading rules cite the agent's source at a fixed commit. No test starts the real agent.
 *
 * The npm registry is unreachable on purpose (KIT_NPM_REGISTRY), so `npm i some-untriaged-pkg`
 * cannot be triaged and must be blocked without a network call.
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
const NO_SH = "the installed hook line is a POSIX sh line; Windows runs the CLI tests below";
const INSTALL = "npm i some-untriaged-pkg";
const SAFE = "ls";

let home = "";
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const gateEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  KIT_NPM_REGISTRY: "http://127.0.0.1:9",
  KIT_OSV_API: "http://127.0.0.1:9",
  KIT_NO_UPDATE_CHECK: "1",
  KIT_HIDE_HOOK_SKIP_BANNER: "1",
});

before(() => {
  // A home with kit's wrapper, so the installers write the `"$HOME/.kit/bin/kit"` line that a
  // person's machine gets, and that line runs this build.
  home = mkdtempSync(join(tmpdir(), "kit-agent-contract-home-"));
  const bin = join(home, ".kit", "bin");
  mkdirSync(bin, { recursive: true });
  if (POSIX) {
    writeFileSync(join(bin, "kit"), `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`);
    chmodSync(join(bin, "kit"), 0o755);
  } else {
    writeFileSync(
      join(bin, "kit.cmd"),
      generateKitCmdWrapper({ nodePath: process.execPath, cliPath: cli }),
    );
  }
  process.env.HOME = home;
  if (!POSIX) process.env.USERPROFILE = home;
  Object.assign(process.env, {
    KIT_NPM_REGISTRY: "http://127.0.0.1:9",
    KIT_OSV_API: "http://127.0.0.1:9",
  });
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete process.env.KIT_NPM_REGISTRY;
  delete process.env.KIT_OSV_API;
  rmTemp(home);
});

function project(t: { after: (fn: () => void) => void }, marker: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-agent-contract-"));
  t.after(() => rmTemp(dir));
  mkdirSync(join(dir, marker), { recursive: true });
  return dir;
}

/** Run a hook command line the way the agents do: through the shell, payload on stdin. */
function runLine(line: string, cwd: string, payload: unknown) {
  return spawnSync("/bin/sh", ["-c", line], {
    cwd,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: gateEnv(),
  });
}

/** Run `kit gate-bash` of this build directly (all platforms). */
function runGate(cwd: string, payload: unknown, args: string[]) {
  return spawnSync(process.execPath, [cli, "gate-bash", ...args], {
    cwd,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: gateEnv(),
  });
}

const lastJson = (stdout: string): Record<string, unknown> | undefined => {
  const line = stdout.trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------------------------------------
// Cline. Source: github.com/cline/cline at cbc7d1419a74464c622117a740fdfe87a5e0a7b2.
// ---------------------------------------------------------------------------------------------

/**
 * VS Code extension payload: `apps/vscode/src/sdk/hooks-adapter.ts:168-174`. `toStringRecord`
 * (`:28-38`) turns the `commands` array into JSON text.
 */
const clineVsCode = (commands: unknown) => ({
  taskId: "task-1",
  preToolUse: {
    toolName: "run_commands",
    parameters: { commands: JSON.stringify(commands) },
  },
});

/** CLI/SDK payload: `sdk/packages/core/src/hooks/hook-file-hooks.ts:236-255`, `:845-867`. */
const clineCli = (input: unknown) => ({
  hookName: "tool_call",
  clineVersion: "",
  timestamp: "2026-11-26T00:00:00.000Z",
  taskId: "task-1",
  sessionContext: { rootSessionId: "task-1" },
  workspaceRoots: ["/repo"],
  userId: "user",
  agent_id: "agent-1",
  parent_agent_id: null,
  iteration: 3,
  tool_call: { id: "call-1", name: "run_commands", input },
  preToolUse: {
    toolName: "run_commands",
    parameters: Object.fromEntries(
      Object.entries(input as Record<string, unknown>).map(([k, v]) => [
        k,
        typeof v === "string" ? v : JSON.stringify(v),
      ]),
    ),
  },
});

/**
 * Cline honours valid stdout JSON at any exit code, and `cancel: true` stops the run
 * (`apps/vscode/src/core/hooks/hook-factory.ts:469-513`, `hooks-adapter.ts:40-55`). Without
 * JSON, a non-zero exit is caught and allowed (`hooks-adapter.ts:191-202`).
 */
const clineBlocks = (r: { stdout: string }) => lastJson(r.stdout)?.cancel === true;

describe("Cline: run_commands through the installed .clinerules/hooks/PreToolUse", () => {
  it(
    "blocks when any command in the list installs, and allows a safe list",
    { skip: POSIX ? false : NO_SH },
    async (t) => {
      const dir = project(t, ".clinerules");
      assert.equal((await installInstallGateCline(dir)).action, "created");
      const hook = join(dir, ".clinerules", "hooks", "PreToolUse");
      const run = (payload: unknown) =>
        spawnSync(hook, [], {
          cwd: dir,
          input: JSON.stringify(payload),
          encoding: "utf8",
          env: gateEnv(),
        });

      const vsDeny = run(clineVsCode([SAFE, INSTALL]));
      assert.ok(clineBlocks(vsDeny), vsDeny.stdout + vsDeny.stderr);
      assert.match(String(lastJson(vsDeny.stdout)?.errorMessage), /some-untriaged-pkg/);
      const vsAllow = run(clineVsCode([SAFE, "pwd"]));
      assert.equal(vsAllow.status, 0, vsAllow.stderr);
      assert.ok(!clineBlocks(vsAllow), vsAllow.stdout);

      const cliDeny = run(clineCli({ commands: [SAFE, INSTALL] }));
      assert.ok(clineBlocks(cliDeny), cliDeny.stdout + cliDeny.stderr);
      const cliAllow = run(clineCli({ commands: [SAFE] }));
      assert.ok(!clineBlocks(cliAllow), cliAllow.stdout);
    },
  );

  it("reads structured {command, args} entries and the legacy single command", async (t) => {
    const dir = project(t, ".clinerules");
    // `StructuredCommandInputSchema`: sdk/packages/core/src/extensions/tools/schemas.ts:133-142.
    const structured = runGate(
      dir,
      clineCli({ commands: [{ command: "npm", args: ["i", "some-untriaged-pkg"] }] }),
      ["--format", "cline"],
    );
    assert.ok(clineBlocks(structured), structured.stdout + structured.stderr);
    // `z.object({ command })`, still accepted by the lenient union (schemas.ts:166-176).
    const legacy = runGate(
      dir,
      { preToolUse: { toolName: "execute_command", parameters: { command: INSTALL } } },
      ["--format", "cline"],
    );
    assert.ok(clineBlocks(legacy), legacy.stdout + legacy.stderr);
    const safe = runGate(
      dir,
      { preToolUse: { toolName: "execute_command", parameters: { command: SAFE } } },
      ["--format", "cline"],
    );
    assert.ok(!clineBlocks(safe), safe.stdout);
  });

  it("blocks a run_commands call whose commands it cannot read", async (t) => {
    const dir = project(t, ".clinerules");
    // A bare string input becomes `{}` in the VS Code adapter (toStringRecord, hooks-adapter.ts:28-31).
    const r = runGate(
      dir,
      { taskId: "t", preToolUse: { toolName: "run_commands", parameters: {} } },
      ["--format", "cline"],
    );
    assert.ok(clineBlocks(r), r.stdout + r.stderr);
    assert.match(String(lastJson(r.stdout)?.errorMessage), /cannot read the commands/);
  });

  it("leaves other tools alone, also a patch sent as a bare string", async (t) => {
    const dir = project(t, ".clinerules");
    const patch = {
      tool_call: {
        id: "c",
        name: "apply_patch",
        input: "*** Begin Patch\n*** Add File: a\n+npm i x\n*** End Patch",
      },
      preToolUse: { toolName: "apply_patch", parameters: {} },
    };
    const r = runGate(dir, patch, ["--format", "cline"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!clineBlocks(r), r.stdout);
  });
});

// ---------------------------------------------------------------------------------------------
// Gemini CLI. Source: github.com/google-gemini/gemini-cli at 60f8082b14ffa7f10b608270232f3f57b5abbec8.
// ---------------------------------------------------------------------------------------------

/**
 * BeforeTool payload: base fields `packages/core/src/hooks/hookEventHandler.ts:371-385`, tool fields
 * `:76-93`, shell input `packages/core/src/tools/shell.ts:115-122`.
 */
const geminiPayload = (command: string) => ({
  session_id: "s-1",
  transcript_path: "/home/u/.gemini/tmp/p/chats/session-1.jsonl",
  cwd: "/repo",
  hook_event_name: "BeforeTool",
  timestamp: "2026-11-26T00:00:00.000Z",
  tool_name: "run_shell_command",
  tool_input: { command, description: "run it" },
});

/**
 * Gemini's reading of a hook's output, `packages/core/src/hooks/hookRunner.ts:451-489` and
 * `:537-560`: stdout (or else stderr) that parses as JSON decides, whatever the exit code; plain
 * text blocks only with an exit code of 2 or more; no output decides nothing.
 */
function geminiDecision(r: { stdout: string; stderr: string; status: number | null }): string {
  const text = r.stdout.trim() || r.stderr.trim();
  if (!text) return "allow";
  try {
    let parsed: unknown = JSON.parse(text);
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
    if (parsed && typeof parsed === "object") {
      const d = (parsed as { decision?: unknown }).decision;
      return d === "deny" || d === "block" ? "deny" : "allow";
    }
  } catch {
    /* plain text */
  }
  const code = r.status || 0;
  return code === 0 || code === 1 ? "allow" : "deny";
}

describe("Gemini CLI: BeforeTool through the installed .gemini/settings.json line", () => {
  it("writes --format gemini and tells the person to trust the folder", async (t) => {
    const dir = project(t, ".gemini");
    const r = await installInstallGateGemini(dir);
    assert.equal(r.action, "created");
    assert.equal(r.notice, GEMINI_TRUST_NOTICE);
    assert.match(r.notice ?? "", /trusted folder/);
    assert.match(r.notice ?? "", /\/permissions trust/);
    const line = JSON.parse(readFileSync(join(dir, ".gemini", "settings.json"), "utf8")).hooks
      .BeforeTool[0].hooks[0].command as string;
    assert.ok(line.endsWith("gate-bash --format gemini"), line);
    assert.equal((await installInstallGateGemini(dir)).notice, GEMINI_TRUST_NOTICE);
  });

  it("refreshes an older kit line in place, without a second hook", async (t) => {
    const dir = project(t, ".gemini");
    const old = {
      theme: "x",
      hooks: {
        BeforeTool: [
          { matcher: "", hooks: [{ type: "command", command: '"$HOME/.kit/bin/kit" gate-bash' }] },
        ],
      },
    };
    writeFileSync(join(dir, ".gemini", "settings.json"), JSON.stringify(old));
    assert.equal((await installInstallGateGemini(dir)).action, "updated");
    const s = JSON.parse(readFileSync(join(dir, ".gemini", "settings.json"), "utf8"));
    assert.equal(s.theme, "x");
    assert.equal(s.hooks.BeforeTool.length, 1);
    assert.equal(s.hooks.BeforeTool[0].hooks.length, 1);
    assert.ok(s.hooks.BeforeTool[0].hooks[0].command.endsWith("gate-bash --format gemini"));
    assert.equal((await installInstallGateGemini(dir)).action, "unchanged");
  });

  it(
    "the installed line denies an install and allows ls, as Gemini reads it",
    { skip: POSIX ? false : NO_SH },
    async (t) => {
      const dir = project(t, ".gemini");
      await installInstallGateGemini(dir);
      const line = JSON.parse(readFileSync(join(dir, ".gemini", "settings.json"), "utf8")).hooks
        .BeforeTool[0].hooks[0].command as string;
      const deny = runLine(line, dir, geminiPayload(INSTALL));
      assert.equal(geminiDecision(deny), "deny", deny.stdout + deny.stderr);
      assert.equal(lastJson(deny.stdout)?.decision, "deny", "the JSON decides, not the exit code");
      assert.equal(deny.status, 2, "exit 2 for harnesses that read the code");
      const allow = runLine(line, dir, geminiPayload(SAFE));
      assert.equal(geminiDecision(allow), "allow", allow.stdout + allow.stderr);
    },
  );

  it("gate-bash --format gemini decides on stdout (all platforms)", async (t) => {
    const dir = project(t, ".gemini");
    const deny = runGate(dir, geminiPayload(INSTALL), ["--format", "gemini"]);
    assert.equal(lastJson(deny.stdout)?.decision, "deny", deny.stdout + deny.stderr);
    assert.match(String(lastJson(deny.stdout)?.reason), /some-untriaged-pkg/);
    assert.equal(deny.status, 2);
    const allow = runGate(dir, geminiPayload(SAFE), ["--format", "gemini"]);
    assert.equal(allow.status, 0, allow.stderr);
    assert.equal(geminiDecision(allow), "allow");
  });

  it(
    "kit agent-config prints the trust step for a Gemini project",
    { skip: POSIX ? false : NO_SH },
    (t) => {
      const dir = project(t, ".gemini");
      writeFileSync(join(dir, ".kit.toml"), "version = 1\n");
      const r = spawnSync(process.execPath, [cli, "agent-config"], {
        cwd: dir,
        encoding: "utf8",
        env: gateEnv(),
        timeout: 120_000,
      });
      assert.ok(r.stdout.includes(GEMINI_TRUST_NOTICE), r.stdout + r.stderr);
    },
  );
});

// ---------------------------------------------------------------------------------------------
// Google Antigravity. Source: https://antigravity.google/docs/hooks.md (fetched 2026-11-26; the
// product is closed source, so these shapes come from its docs).
// ---------------------------------------------------------------------------------------------

const antigravityPayload = (command: string) => ({
  toolCall: {
    name: "run_command",
    args: { CommandLine: command, Cwd: "/workspace/project", WaitMsBeforeAsync: 5000 },
  },
  stepIdx: 19,
  conversationId: "ec33ebf9-0000-0000-0000-000000000000",
  workspacePaths: ["/workspace/project"],
  transcriptPath: "~/.gemini/antigravity/brain/x/.system_generated/logs/transcript.jsonl",
  artifactDirectoryPath: "/tmp/artifacts",
  modelName: "gemini-3.6-flash-medium",
});

type AntigravityConfig = Record<
  string,
  { enabled?: boolean; PreToolUse?: { matcher: string; hooks: { command: string }[] }[] } & Record<
    string,
    unknown
  >
>;

describe("Antigravity: hooks.json keyed by hook name", () => {
  it("writes kit's hook under its own name, idempotently", async (t) => {
    const dir = project(t, ".agents");
    assert.equal((await installInstallGateAntigravity(dir)).action, "created");
    const cfg = JSON.parse(
      readFileSync(join(dir, ".agents", "hooks.json"), "utf8"),
    ) as AntigravityConfig;
    assert.deepEqual(Object.keys(cfg), [ANTIGRAVITY_HOOK_NAME]);
    const hook = cfg[ANTIGRAVITY_HOOK_NAME];
    assert.equal(hook.enabled, true);
    assert.equal(hook.PreToolUse?.[0].matcher, "run_command");
    assert.ok(hook.PreToolUse?.[0].hooks[0].command.endsWith("gate-bash --format antigravity"));
    assert.equal((await installInstallGateAntigravity(dir)).action, "unchanged");
  });

  it("moves kit's gate out of the old {hooks:{...}} entry and keeps every user hook", async (t) => {
    const dir = project(t, ".agents");
    const userGroup = { matcher: "view_file", hooks: [{ type: "command", command: "./audit.sh" }] };
    const old = {
      hooks: {
        PreToolUse: [
          {
            matcher: "run_command",
            hooks: [{ type: "command", command: '"$HOME/.kit/bin/kit" gate-bash' }],
          },
          userGroup,
        ],
        PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: "./log.sh" }] }],
      },
      "safety-gate": { enabled: true, PreToolUse: [userGroup] },
    };
    writeFileSync(join(dir, ".agents", "hooks.json"), JSON.stringify(old));
    assert.equal((await installInstallGateAntigravity(dir)).action, "updated");
    const cfg = JSON.parse(
      readFileSync(join(dir, ".agents", "hooks.json"), "utf8"),
    ) as AntigravityConfig;
    assert.deepEqual(cfg.hooks.PreToolUse, [userGroup], "user group stays, kit's leaves");
    assert.deepEqual(cfg.hooks.PostToolUse, old.hooks.PostToolUse);
    assert.deepEqual(cfg["safety-gate"], old["safety-gate"]);
    assert.equal(cfg[ANTIGRAVITY_HOOK_NAME].PreToolUse?.length, 1);
    assert.equal((await installInstallGateAntigravity(dir)).action, "unchanged");
  });

  it("drops the old entry when it held only kit's gate", async (t) => {
    const dir = project(t, ".agents");
    const old = {
      hooks: {
        PreToolUse: [
          {
            matcher: "run_command",
            hooks: [{ type: "command", command: "kit gate-bash --format antigravity" }],
          },
        ],
      },
    };
    writeFileSync(join(dir, ".agents", "hooks.json"), JSON.stringify(old));
    assert.equal((await installInstallGateAntigravity(dir)).action, "updated");
    const cfg = JSON.parse(
      readFileSync(join(dir, ".agents", "hooks.json"), "utf8"),
    ) as AntigravityConfig;
    assert.deepEqual(Object.keys(cfg), [ANTIGRAVITY_HOOK_NAME]);
  });

  it("refuses to overwrite a hooks.json it cannot parse", async (t) => {
    const dir = project(t, ".agents");
    writeFileSync(join(dir, ".agents", "hooks.json"), "{ not json");
    assert.equal((await installInstallGateAntigravity(dir)).action, "failed");
    assert.equal(readFileSync(join(dir, ".agents", "hooks.json"), "utf8"), "{ not json");
  });

  it(
    "the installed line writes a stdout decision and exits 2 on a deny",
    { skip: POSIX ? false : NO_SH },
    async (t) => {
      const dir = project(t, ".agents");
      await installInstallGateAntigravity(dir);
      const cfg = JSON.parse(
        readFileSync(join(dir, ".agents", "hooks.json"), "utf8"),
      ) as AntigravityConfig;
      const line = cfg[ANTIGRAVITY_HOOK_NAME].PreToolUse?.[0].hooks[0].command ?? "";
      const deny = runLine(line, dir, antigravityPayload(INSTALL));
      assert.equal(lastJson(deny.stdout)?.decision, "deny", deny.stdout + deny.stderr);
      assert.equal(deny.status, 2);
      const allow = runLine(line, dir, antigravityPayload(SAFE));
      assert.deepEqual(lastJson(allow.stdout), { decision: "allow" }, allow.stderr);
      assert.equal(allow.status, 0);
    },
  );
});

// ---------------------------------------------------------------------------------------------
// OpenCode. Source: github.com/sst/opencode at 697db192101b3b3d3f576b826287b48fcf96a73b (v2.4.1),
// and tag v1.19.6 (f4e363c8) for the 1.x loader.
// ---------------------------------------------------------------------------------------------

/**
 * OpenCode 2.x module check, `packages/core/src/plugin/module.ts:81-93`: a default export with a
 * string `id` and an `effect` or `setup` function.
 */
function loadsInV2(mod: Record<string, unknown>): boolean {
  const d = mod.default as Record<string, unknown> | undefined;
  return (
    !!d &&
    typeof d === "object" &&
    typeof d.id === "string" &&
    (typeof d.effect === "function" || typeof d.setup === "function")
  );
}

/**
 * OpenCode 1.4+ `readV1Plugin` in detect mode (`packages/opencode/src/plugin/shared.ts:272-303` at
 * v1.19.6): a default object with `id` and a `server` function, and no `tui`.
 */
function v1Server(
  mod: Record<string, unknown>,
): ((...a: unknown[]) => Promise<Record<string, unknown>>) | undefined {
  const d = mod.default as Record<string, unknown> | undefined;
  if (!d || typeof d !== "object" || !("id" in d || "server" in d)) return undefined;
  if (typeof d.server !== "function" || "tui" in d) return undefined;
  return d.server as (...a: unknown[]) => Promise<Record<string, unknown>>;
}

describe("OpenCode: one plugin file for 2.x and 1.4+", () => {
  it("2.x: setup registers execute.before, which rejects an install on `shell` and passes ls", async (t) => {
    const dir = project(t, ".opencode");
    assert.equal((await installInstallGateOpenCode(dir)).action, "created");
    const mod = (await import(
      pathToFileURL(join(dir, ".opencode", "plugin", "kit-install-gate.js")).href
    )) as Record<string, unknown>;
    assert.ok(loadsInV2(mod), "OpenCode 2.x would load this module");
    const hooks: Record<string, (event: unknown) => Promise<void>> = {};
    const ctx = {
      tool: {
        hook: async (name: string, cb: (event: unknown) => Promise<void>) =>
          void (hooks[name] = cb),
      },
    };
    await (mod.default as { setup: (c: unknown) => Promise<void> }).setup(ctx);
    assert.equal(typeof hooks["execute.before"], "function");
    // Event shape: packages/plugin/src/promise/tool.ts:51-61, built in packages/core/src/tool.ts:163-173.
    const event = (command: string) => ({
      tool: "shell",
      codemode: false,
      sessionID: "ses_1",
      agent: "build",
      messageID: "msg_1",
      id: "call_1",
      input: { command, workdir: dir },
    });
    await assert.rejects(
      hooks["execute.before"](event(INSTALL)),
      /kit install-gate blocked: .*some-untriaged-pkg/s,
    );
    await assert.doesNotReject(hooks["execute.before"](event(SAFE)));
    await assert.doesNotReject(hooks["execute.before"]({ ...event(INSTALL), tool: "read" }));
  });

  it("1.4+: default.server returns tool.execute.before, which blocks the same way", async (t) => {
    const dir = project(t, ".opencode");
    await installInstallGateOpenCode(dir);
    const mod = (await import(
      pathToFileURL(join(dir, ".opencode", "plugin", "kit-install-gate.js")).href + "?v1"
    )) as Record<string, unknown>;
    const server = v1Server(mod);
    assert.ok(server, "OpenCode 1.4+ would read default.server");
    const hooks = (await server({})) as Record<string, (i: unknown, o: unknown) => Promise<void>>;
    await assert.rejects(
      hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: INSTALL } }),
      /kit install-gate blocked/,
    );
    await assert.doesNotReject(
      hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: SAFE } }),
    );
  });

  it("upgrades the V1-only plugin an older kit wrote", async (t) => {
    const dir = project(t, ".opencode");
    const path = join(dir, ".opencode", "plugin", "kit-install-gate.js");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      '// kit install-gate\n// Generated by `kit agent-config --install-gate`. Delete this file to disable.\nexport const kitInstallGate = async () => ({ "tool.execute.before": async () => {} });\n',
    );
    assert.equal((await installInstallGateOpenCode(dir)).action, "updated");
    const mod = (await import(pathToFileURL(path).href + "?upgraded")) as Record<string, unknown>;
    assert.ok(loadsInV2(mod));
  });
});
