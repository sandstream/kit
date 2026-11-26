/**
 * How kit wires `kit gate-bash` into Codex, Amazon Q, Kiro, Cursor, Factory Droid and Aider,
 * against each agent's own contract. Sources, read 2026-11-26:
 *   - Codex: openai/codex 8727186a0a0e097f5e4496ba830f5d59c235b88c, hooks/src/engine/discovery.rs:953-960
 *     (a hook runs only when trusted), core/src/tools/handlers/apply_patch.rs:370-375 (apply_patch
 *     sends the raw patch in tool_input.command).
 *   - Amazon Q: aws/amazon-q-developer-cli 15cc8f3cd18c4272925ce1c7053268eedff1ea0a,
 *     crates/chat-cli/src/cli/chat/tools/mod.rs:74-87 (`execute_cmd` on Windows),
 *     cli/chat/cli/hooks.rs:55-85 + util/pattern_matching.rs:6-22 (matcher semantics),
 *     cli/chat/tools/fs_write.rs:57-86 (fs_write is tagged by `command`).
 *   - Kiro: kiro.dev/docs/hooks.md "Hook file schema" (`.kiro/hooks/<id>.json`, IDE 1.0 + CLI V3),
 *     /docs/cli/v3/hooks-migration.md (legacy object form still accepted; `execute_cmd` is a CLI 2.x
 *     shell name), /docs/custom-agents/configuration-reference.md (agents may be `.md`),
 *     /docs/tools.md (the `shell` tag is execute_bash / execute_pwsh).
 *   - Cursor: cursor.com/docs/agent/hooks (`failClosed`: crash, timeout, non-zero exit or NO OUTPUT
 *     block when true).
 *   - Factory Droid: docs.factory.com/reference/hooks-reference.md ("Standalone hooks.json files are
 *     keyed directly by event name"; `onFailure: "block"`).
 *   - Aider: Aider-AI/aider 5dc9490bb35f9729ef2c95d00a19ccd30c26339c, aider/repo.py:278-279.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  installAiderRules,
  installInstallGateAmazonQ,
  installInstallGateCodex,
  installInstallGateCursor,
  installInstallGateDroid,
  installInstallGateKiro,
} from "./agent-config.js";
import { extractCommandFromHookPayload } from "./install-gate.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
const BLOCKED = "npm install https://example.invalid/x.tgz";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

/** Amazon Q's `hook_matches_tool` for a built-in tool (hooks.rs:55-85, pattern_matching.rs:6-22). */
function amazonQMatches(matcher: string | undefined, tool: string): boolean {
  if (matcher === undefined || matcher === "*") return true;
  if (matcher === "@builtin") return true;
  if (matcher === tool) return true;
  if (matcher.includes("*") || matcher.includes("?")) {
    const re = new RegExp(
      `^${matcher
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")}$`,
    );
    return re.test(tool);
  }
  return false;
}

describe("row 1: Codex gate needs the user's trust", () => {
  it("returns the activation steps, and keeps the matcher on Bash only (no apply_patch)", async () => {
    const dir = tmp("kit-wire-codex-");
    const codexHome = tmp("kit-wire-codexhome-");
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      mkdirSync(join(dir, ".codex"));
      const r = await installInstallGateCodex(dir);
      assert.equal(r.action, "created");
      const steps = (r.next ?? []).join("\n");
      assert.match(steps, /trust prompt/, "names the project-trust step");
      assert.match(steps, /\/hooks/, "names the hook-trust step");
      assert.match(steps, /never writes the trust/);
      const txt = readFileSync(join(dir, ".codex", "config.toml"), "utf-8");
      assert.match(txt, /matcher = "\^Bash\$"/);
      assert.doesNotMatch(txt, /apply_patch|Write|Edit/);
      // kit wrote no trust anywhere
      assert.equal(existsSync(join(codexHome, "config.toml")), false);
      // and an unchanged re-run still tells the user, since the hook is still untrusted
      const again = await installInstallGateCodex(dir);
      assert.equal(again.action, "unchanged");
      assert.ok((again.next ?? []).length > 0);
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
      rmTemp(dir);
      rmTemp(codexHome);
    }
  });

  it("an apply_patch payload would be misread as a shell command, which is why it stays out", () => {
    const patch = "*** Begin Patch\n*** Add File: a.txt\n+hello\n*** End Patch\n";
    assert.equal(
      extractCommandFromHookPayload({ tool_name: "apply_patch", tool_input: { command: patch } }),
      patch,
    );
  });
});

describe("row 2: Amazon Q shell tool is execute_cmd on Windows", () => {
  it("wires execute_bash and execute_cmd, and migrates an older kit entry once", async () => {
    const dir = tmp("kit-wire-q-");
    try {
      mkdirSync(join(dir, ".amazonq", "cli-agents"), { recursive: true });
      const file = join(dir, ".amazonq", "cli-agents", "default.json");
      writeFileSync(
        file,
        JSON.stringify({
          name: "default",
          hooks: { preToolUse: [{ matcher: "execute_bash", command: "/x/kit gate-bash" }] },
        }),
      );
      assert.equal((await installInstallGateAmazonQ(dir)).action, "updated");
      const pre = readJson(file).hooks.preToolUse as { matcher: string; command: string }[];
      assert.deepEqual(pre.map((h) => h.matcher).sort(), ["execute_bash", "execute_cmd"]);
      assert.equal((await installInstallGateAmazonQ(dir)).action, "unchanged");
      assert.equal(readJson(file).hooks.preToolUse.length, 2, "no duplicate on re-run");
    } finally {
      rmTemp(dir);
    }
  });

  it("fs_write (tool_input.command = create/str_replace) can never reach gate-bash", async () => {
    const dir = tmp("kit-wire-q-fs-");
    try {
      mkdirSync(join(dir, ".amazonq", "cli-agents"), { recursive: true });
      mkdirSync(join(dir, ".kiro", "agents"), { recursive: true });
      writeFileSync(join(dir, ".amazonq", "cli-agents", "a.json"), "{}");
      writeFileSync(join(dir, ".kiro", "agents", "a.json"), "{}");
      await installInstallGateAmazonQ(dir);
      await installInstallGateKiro(dir);
      const matchers = [
        ...readJson(join(dir, ".amazonq", "cli-agents", "a.json")).hooks.preToolUse,
        ...readJson(join(dir, ".kiro", "agents", "a.json")).hooks.preToolUse,
      ].map((h: { matcher?: string }) => h.matcher);
      assert.ok(matchers.length >= 4);
      for (const m of matchers) {
        assert.ok(m !== undefined, "every kit entry has a matcher (no matcher = every tool)");
        for (const tool of ["fs_write", "fs_read", "use_aws", "@srv/tool"]) {
          assert.equal(amazonQMatches(m, tool), false, `${m} must not match ${tool}`);
        }
      }
      for (const shell of ["execute_bash", "execute_cmd"]) {
        assert.ok(
          matchers.some((m) => amazonQMatches(m, shell)),
          `${shell} is gated`,
        );
      }
      // The reason it matters: the shared extractor would read the fs_write verb as a command.
      const fsWrite = { tool_name: "fs_write", tool_input: { command: "create", path: "a" } };
      assert.equal(extractCommandFromHookPayload(fsWrite), "create");
      // Kiro's standalone hook uses the `shell` tag, which holds no write tool.
      const kiro = readJson(join(dir, ".kiro", "hooks", "kit-install-gate.json"));
      assert.equal(kiro.hooks[0].matcher, "shell");
    } finally {
      rmTemp(dir);
    }
  });
});

describe("row 3: Cursor and Droid must fail closed", () => {
  it("Cursor: new entry has failClosed and the cursor stdout format", async () => {
    const dir = tmp("kit-wire-cursor-");
    try {
      mkdirSync(join(dir, ".cursor"));
      assert.equal((await installInstallGateCursor(dir)).action, "created");
      const hook = readJson(join(dir, ".cursor", "hooks.json")).hooks.beforeShellExecution[0];
      assert.equal(hook.failClosed, true);
      assert.ok(hook.command.endsWith("gate-bash --format cursor"), hook.command);
    } finally {
      rmTemp(dir);
    }
  });

  it("Cursor: migrates an older kit entry in place, idempotently, keeping other hooks", async () => {
    const dir = tmp("kit-wire-cursor-mig-");
    try {
      mkdirSync(join(dir, ".cursor"));
      const file = join(dir, ".cursor", "hooks.json");
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          hooks: {
            beforeShellExecution: [{ command: "./mine.sh" }, { command: "/x/kit gate-bash" }],
          },
        }),
      );
      assert.equal((await installInstallGateCursor(dir)).action, "updated");
      const pre = readJson(file).hooks.beforeShellExecution;
      assert.equal(pre.length, 2);
      assert.deepEqual(pre[0], { command: "./mine.sh" });
      assert.deepEqual(pre[1], { command: "/x/kit gate-bash --format cursor", failClosed: true });
      assert.equal((await installInstallGateCursor(dir)).action, "unchanged");
    } finally {
      rmTemp(dir);
    }
  });

  it("Cursor: gate-bash --format cursor prints a JSON verdict on allow, exit 2 on deny", () => {
    const run = (command: string) =>
      spawnSync(process.execPath, [cli, "gate-bash", "--format", "cursor"], {
        input: JSON.stringify({
          command,
          cwd: process.cwd(),
          hook_event_name: "beforeShellExecution",
        }),
        encoding: "utf8",
        env: { ...process.env, KIT_OFFLINE: "1" },
      });
    const allowed = run("ls -la");
    assert.equal(allowed.status, 0, allowed.stderr);
    // failClosed treats "no output" as a failure, so the allow must be on stdout, alone.
    assert.deepEqual(JSON.parse(allowed.stdout), { permission: "allow" });
    const denied = run(BLOCKED);
    assert.equal(denied.status, 2, denied.stdout + denied.stderr);
  });

  it("Droid: writes hooks.json keyed by event, with onFailure block", async () => {
    const dir = tmp("kit-wire-droid-");
    try {
      mkdirSync(join(dir, ".factory"));
      assert.equal((await installInstallGateDroid(dir)).action, "created");
      const cfg = readJson(join(dir, ".factory", "hooks.json"));
      assert.equal(cfg.hooks, undefined, "no `hooks` wrapper in a standalone hooks.json");
      assert.equal(cfg.PreToolUse[0].matcher, "Execute");
      assert.equal(cfg.PreToolUse[0].hooks[0].onFailure, "block");
      assert.ok(cfg.PreToolUse[0].hooks[0].command.endsWith("gate-bash"));
      assert.equal((await installInstallGateDroid(dir)).action, "unchanged");
    } finally {
      rmTemp(dir);
    }
  });

  it("Droid: lifts an older kit entry out of the `hooks` wrapper, keeping the user's hooks", async () => {
    const dir = tmp("kit-wire-droid-mig-");
    try {
      mkdirSync(join(dir, ".factory"));
      const file = join(dir, ".factory", "hooks.json");
      const mine = { matcher: "Edit", hooks: [{ type: "command", command: "./fmt.sh" }] };
      writeFileSync(
        file,
        JSON.stringify({
          PreToolUse: [mine],
          hooks: {
            PreToolUse: [
              { matcher: "Execute", hooks: [{ type: "command", command: "/x/kit gate-bash" }] },
            ],
          },
        }),
      );
      assert.equal((await installInstallGateDroid(dir)).action, "updated");
      const cfg = readJson(file);
      assert.equal(cfg.hooks, undefined);
      assert.deepEqual(cfg.PreToolUse[0], mine);
      assert.deepEqual(cfg.PreToolUse[1], {
        matcher: "Execute",
        hooks: [{ type: "command", command: "/x/kit gate-bash", onFailure: "block" }],
      });
      assert.equal((await installInstallGateDroid(dir)).action, "unchanged");
    } finally {
      rmTemp(dir);
    }
  });

  it("Droid: fixes a legacy .factory/hooks/hooks.json in place while hooks.json is absent", async () => {
    const dir = tmp("kit-wire-droid-legacy-");
    try {
      mkdirSync(join(dir, ".factory", "hooks"), { recursive: true });
      const legacy = join(dir, ".factory", "hooks", "hooks.json");
      writeFileSync(
        legacy,
        JSON.stringify({
          hooks: {
            PreToolUse: [
              { matcher: "Execute", hooks: [{ type: "command", command: "/x/cli.js gate-bash" }] },
            ],
          },
        }),
      );
      const r = await installInstallGateDroid(dir);
      assert.equal(r.action, "updated");
      assert.equal(r.file, ".factory/hooks/hooks.json");
      assert.equal(existsSync(join(dir, ".factory", "hooks.json")), false);
      const cfg = readJson(legacy);
      assert.equal(cfg.PreToolUse[0].hooks[0].onFailure, "block");
      assert.equal((await installInstallGateDroid(dir)).action, "unchanged");
    } finally {
      rmTemp(dir);
    }
  });
});

describe("row 4: Kiro reads standalone .kiro/hooks/*.json", () => {
  it("writes the standalone hook even when the only agent is a .md file", async () => {
    const dir = tmp("kit-wire-kiro-md-");
    try {
      mkdirSync(join(dir, ".kiro", "agents"), { recursive: true });
      const md = "---\nname: backend\n---\nYou write code.\n";
      writeFileSync(join(dir, ".kiro", "agents", "backend.md"), md);
      const r = await installInstallGateKiro(dir);
      assert.equal(r.action, "created", r.detail);
      assert.match(r.detail ?? "", /1 \.md agent/);
      const cfg = readJson(join(dir, ".kiro", "hooks", "kit-install-gate.json"));
      assert.equal(cfg.version, "v1");
      assert.equal(cfg.hooks.length, 1);
      assert.equal(cfg.hooks[0].trigger, "PreToolUse");
      assert.equal(cfg.hooks[0].matcher, "shell");
      assert.equal(cfg.hooks[0].action.type, "command");
      assert.ok(cfg.hooks[0].action.command.endsWith("gate-bash"));
      assert.equal(readFileSync(join(dir, ".kiro", "agents", "backend.md"), "utf-8"), md);
      assert.equal((await installInstallGateKiro(dir)).action, "unchanged");
    } finally {
      rmTemp(dir);
    }
  });

  it("does not claim an array-form (V3) agent as wired, and leaves it unchanged", async () => {
    const dir = tmp("kit-wire-kiro-arr-");
    try {
      mkdirSync(join(dir, ".kiro", "agents"), { recursive: true });
      const file = join(dir, ".kiro", "agents", "v3.json");
      const body = JSON.stringify({
        name: "v3",
        hooks: [{ name: "x", trigger: "Stop", action: { type: "command", command: "true" } }],
      });
      writeFileSync(file, body);
      await installInstallGateKiro(dir);
      assert.equal(readFileSync(file, "utf-8"), body);
      assert.ok(existsSync(join(dir, ".kiro", "hooks", "kit-install-gate.json")));
    } finally {
      rmTemp(dir);
    }
  });

  it("keeps the legacy object form for CLI 2.x agents, with execute_cmd added", async () => {
    const dir = tmp("kit-wire-kiro-legacy-");
    try {
      mkdirSync(join(dir, ".kiro", "agents"), { recursive: true });
      const file = join(dir, ".kiro", "agents", "old.json");
      writeFileSync(
        file,
        JSON.stringify({
          hooks: { preToolUse: [{ matcher: "execute_bash", command: "/x/kit gate-bash" }] },
        }),
      );
      await installInstallGateKiro(dir);
      const pre = readJson(file).hooks.preToolUse as { matcher: string }[];
      assert.deepEqual(pre.map((h) => h.matcher).sort(), ["execute_bash", "execute_cmd"]);
      assert.equal((await installInstallGateKiro(dir)).action, "unchanged");
    } finally {
      rmTemp(dir);
    }
  });
});

describe("row 5: Aider rules name git-commit-verify", () => {
  it("CONVENTIONS.md tells Aider users that kit's git hooks need git-commit-verify", async () => {
    const dir = tmp("kit-wire-aider-");
    try {
      writeFileSync(join(dir, ".aider.conf.yml"), "model: x\n");
      await installAiderRules(dir);
      const conv = readFileSync(join(dir, "CONVENTIONS.md"), "utf-8");
      assert.match(conv, /git-commit-verify: true/);
      assert.match(conv, /--no-verify/);
      assert.equal((await installAiderRules(dir)).action, "unchanged");
    } finally {
      rmTemp(dir);
    }
  });
});
