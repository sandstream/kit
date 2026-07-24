import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KIT_BLOCK_BEGIN,
  KIT_BLOCK_END,
  upsertKitBlock,
  detectAgentTargets,
  writeAgentConfig,
  installKitPermissions,
  installInstallGate,
  installBrokerGates,
  installInstallGateCodex,
  installInstallGateAmazonQ,
  installInstallGateKiro,
  installInstallGateDroid,
  installInstallGateAugment,
  installInstallGateAntigravity,
  installAiderRules,
  mergeAiderRead,
  installInstallGateGemini,
  installInstallGateCursor,
  installInstallGateOpenCode,
  installInstallGateCline,
  kitGateInvocation,
  kitGateArgv,
  READONLY_KIT_PERMISSIONS,
  gateLiveness,
} from "./agent-config.js";
import { kitWrapperPath, kitBinDir } from "./kit-wrapper.js";
import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "kit-agentcfg-"));
}

describe("upsertKitBlock", () => {
  it("creates a managed block in an empty file", () => {
    const { next, action } = upsertKitBlock("");
    assert.equal(action, "created");
    assert.ok(next.includes(KIT_BLOCK_BEGIN));
    assert.ok(next.includes(KIT_BLOCK_END));
    assert.ok(next.includes("kit triage"));
  });

  it("appends after existing content without clobbering it", () => {
    const { next, action } = upsertKitBlock("# My Project\n\nExisting rules.\n");
    assert.equal(action, "created");
    assert.ok(next.startsWith("# My Project\n\nExisting rules.\n"));
    assert.ok(next.includes(KIT_BLOCK_BEGIN));
  });

  it("is idempotent — re-running an unchanged block is a no-op", () => {
    const once = upsertKitBlock("# Doc\n").next;
    const twice = upsertKitBlock(once);
    assert.equal(twice.action, "unchanged");
    assert.equal(twice.next, once);
  });

  it("updates only the marked region, preserving surrounding edits", () => {
    const base = upsertKitBlock("# Doc\n").next;
    // Simulate a user editing OUTSIDE the markers + a stale block INSIDE.
    const edited =
      base.replace("kit triage", "STALE_PLACEHOLDER") + "\n## My own section\nkeep me\n";
    const { next, action } = upsertKitBlock(edited);
    assert.equal(action, "updated");
    assert.ok(next.includes("kit triage"), "block refreshed");
    assert.ok(!next.includes("STALE_PLACEHOLDER"), "stale content inside markers replaced");
    assert.ok(next.includes("## My own section"), "content outside markers preserved");
    assert.ok(next.includes("keep me"));
  });

  it("does not duplicate the block on repeated upserts", () => {
    let c = "# Doc\n";
    for (let i = 0; i < 3; i++) c = upsertKitBlock(c).next;
    const begins = c.split(KIT_BLOCK_BEGIN).length - 1;
    assert.equal(begins, 1);
  });
});

describe("detectAgentTargets", () => {
  it("defaults to CLAUDE.md + AGENTS.md when nothing is present", () => {
    const dir = tmpRepo();
    try {
      const files = detectAgentTargets(dir)
        .map((t) => t.file)
        .sort();
      assert.deepEqual(files, ["AGENTS.md", "CLAUDE.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects Claude Code via an existing .claude/ dir", () => {
    const dir = tmpRepo();
    try {
      mkdirSync(join(dir, ".claude"));
      const files = detectAgentTargets(dir).map((t) => t.file);
      assert.deepEqual(files, ["CLAUDE.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("wires AGENTS.md for an OpenCode-only project (opencode.json, no .codex)", () => {
    const dir = tmpRepo();
    try {
      writeFileSync(join(dir, "opencode.json"), "{}\n");
      const files = detectAgentTargets(dir).map((t) => t.file);
      assert.deepEqual(files, ["AGENTS.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects an OpenCode project via a .opencode/ dir too", () => {
    const dir = tmpRepo();
    try {
      mkdirSync(join(dir, ".opencode"));
      const files = detectAgentTargets(dir).map((t) => t.file);
      assert.deepEqual(files, ["AGENTS.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects Cursor + Cline via their rules files", () => {
    const dir = tmpRepo();
    try {
      writeFileSync(join(dir, ".cursorrules"), "rules\n");
      writeFileSync(join(dir, ".clinerules"), "rules\n");
      const agents = detectAgentTargets(dir)
        .map((t) => t.agent)
        .sort();
      assert.deepEqual(agents, ["Cline", "Cursor"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("wires Copilot via a .vscode/ dir (→ .github/copilot-instructions.md)", () => {
    const dir = tmpRepo();
    try {
      mkdirSync(join(dir, ".vscode"));
      const files = detectAgentTargets(dir).map((t) => t.file);
      assert.deepEqual(files, [".github/copilot-instructions.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects Copilot via an existing .github/copilot-instructions.md", () => {
    const dir = tmpRepo();
    try {
      mkdirSync(join(dir, ".github"));
      writeFileSync(join(dir, ".github", "copilot-instructions.md"), "# instructions\n");
      const agents = detectAgentTargets(dir).map((t) => t.agent);
      assert.deepEqual(agents, ["Copilot"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects Gemini CLI via a .gemini/ dir (→ GEMINI.md)", () => {
    const dir = tmpRepo();
    try {
      mkdirSync(join(dir, ".gemini"));
      const files = detectAgentTargets(dir).map((t) => t.file);
      assert.deepEqual(files, ["GEMINI.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects Augment via a .augment/ dir (→ .augment-guidelines)", () => {
    const dir = tmpRepo();
    try {
      mkdirSync(join(dir, ".augment"));
      const files = detectAgentTargets(dir).map((t) => t.file);
      assert.deepEqual(files, [".augment-guidelines"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("wires AGENTS.md for Kiro (.kiro/), Droid (.factory/) and Kilo (.kilocode/.kilo) projects", () => {
    for (const marker of [".kiro", ".factory", ".kilocode", ".kilo"]) {
      const dir = tmpRepo();
      try {
        mkdirSync(join(dir, marker));
        const files = detectAgentTargets(dir).map((t) => t.file);
        assert.deepEqual(files, ["AGENTS.md"], `${marker} → AGENTS.md`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("wires AGENTS.md for a Kilo project marked by kilo.jsonc", () => {
    const dir = tmpRepo();
    try {
      writeFileSync(join(dir, "kilo.jsonc"), "{}\n");
      const files = detectAgentTargets(dir).map((t) => t.file);
      assert.deepEqual(files, ["AGENTS.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("writeAgentConfig", () => {
  it("writes the block to detected targets", async () => {
    const dir = tmpRepo();
    try {
      mkdirSync(join(dir, ".claude"));
      const results = await writeAgentConfig(dir);
      assert.equal(results.length, 1);
      assert.equal(results[0].file, "CLAUDE.md");
      assert.equal(results[0].action, "created");
      const written = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
      assert.ok(written.includes(KIT_BLOCK_BEGIN) && written.includes(KIT_BLOCK_END));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates the parent dir for a nested target (Copilot's .github/copilot-instructions.md)", async () => {
    const dir = tmpRepo();
    try {
      const t = [{ agent: "Copilot", file: ".github/copilot-instructions.md" }];
      const results = await writeAgentConfig(dir, t);
      assert.equal(results[0].action, "created");
      assert.ok(existsSync(join(dir, ".github", "copilot-instructions.md")), "file created");
      const written = readFileSync(join(dir, ".github", "copilot-instructions.md"), "utf-8");
      assert.ok(written.includes(KIT_BLOCK_BEGIN) && written.includes(KIT_BLOCK_END));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves an existing CLAUDE.md and appends the block", async () => {
    const dir = tmpRepo();
    try {
      writeFileSync(join(dir, "CLAUDE.md"), "# Existing\n\nMy rules.\n");
      await writeAgentConfig(dir, [{ agent: "Claude Code", file: "CLAUDE.md" }]);
      const written = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
      assert.ok(written.startsWith("# Existing\n\nMy rules.\n"));
      assert.ok(written.includes(KIT_BLOCK_BEGIN));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("second run is unchanged (idempotent on disk)", async () => {
    const dir = tmpRepo();
    try {
      const t = [{ agent: "Claude Code", file: "CLAUDE.md" }];
      await writeAgentConfig(dir, t);
      const after1 = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
      const results = await writeAgentConfig(dir, t);
      assert.equal(results[0].action, "unchanged");
      assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf-8"), after1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses + does not write in read-only mode", async () => {
    const dir = tmpRepo();
    process.env.KIT_READ_ONLY = "1";
    try {
      const results = await writeAgentConfig(dir, [{ agent: "Claude Code", file: "CLAUDE.md" }]);
      assert.equal(results[0].action, "failed");
      assert.equal(existsSync(join(dir, "CLAUDE.md")), false);
    } finally {
      delete process.env.KIT_READ_ONLY;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("installKitPermissions", () => {
  it("grants the read-only kit allow-rules in .claude/settings.json, idempotently", async () => {
    const dir = tmpRepo();
    try {
      writeFileSync(join(dir, "CLAUDE.md"), "# x\n");
      const r1 = await installKitPermissions(dir);
      assert.equal(r1.action, "created");
      assert.equal(r1.added.length, READONLY_KIT_PERMISSIONS.length);

      const s = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf-8"));
      assert.ok(s.permissions.allow.includes("Bash(kit check:*)"));
      assert.ok(s.permissions.allow.includes("Bash(kit memory search:*)"));
      // Never grants mutating commands, never writes a deny rule or a mode.
      assert.ok(
        !s.permissions.allow.some(
          (r: string) => r.includes("kit secrets") || r.includes("kit fix"),
        ),
      );
      assert.equal(s.permissions.deny, undefined);
      assert.equal(s.permissions.defaultMode, undefined);

      const r2 = await installKitPermissions(dir);
      assert.equal(r2.action, "unchanged");
      assert.equal(r2.added.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves existing allow rules and other settings keys", async () => {
    const dir = tmpRepo();
    try {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(
        join(dir, ".claude", "settings.json"),
        JSON.stringify({
          permissions: { allow: ["Bash(npm run:*)"] },
          enableAllProjectMcpServers: true,
        }),
      );
      await installKitPermissions(dir);
      const s = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf-8"));
      assert.ok(s.permissions.allow.includes("Bash(npm run:*)"), "keeps the user's rule");
      assert.ok(s.permissions.allow.includes("Bash(kit check:*)"), "adds kit rules");
      assert.equal(s.enableAllProjectMcpServers, true, "preserves unrelated keys");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips when no Claude Code project is present", async () => {
    const dir = tmpRepo();
    try {
      const r = await installKitPermissions(dir);
      assert.equal(r.action, "skipped");
      assert.equal(existsSync(join(dir, ".claude", "settings.json")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("installInstallGate", () => {
  it("writes a PreToolUse Bash gate to .claude/settings.json, idempotently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-gate-"));
    try {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      const r1 = await installInstallGate(dir);
      assert.equal(r1.action, "created");
      const s = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf-8"));
      const groups = s.hooks.PreToolUse;
      assert.ok(Array.isArray(groups) && groups.length === 1);
      assert.equal(groups[0].matcher, "Bash");
      assert.ok(groups[0].hooks[0].command.endsWith("gate-bash"));

      const r2 = await installInstallGate(dir);
      assert.equal(r2.action, "unchanged");
      const s2 = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf-8"));
      assert.equal(s2.hooks.PreToolUse.length, 1, "no duplicate group on re-run");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves other hooks and settings keys", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-gate2-"));
    try {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(
        join(dir, ".claude", "settings.json"),
        JSON.stringify({
          hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] },
          model: "opus",
        }),
      );
      await installInstallGate(dir);
      const s = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf-8"));
      assert.equal(s.model, "opus", "keeps other keys");
      assert.ok(s.hooks.SessionStart, "keeps other hooks");
      assert.ok(s.hooks.PreToolUse[0].hooks[0].command.endsWith("gate-bash"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips when no Claude Code project is present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-gate3-"));
    try {
      const r = await installInstallGate(dir);
      assert.equal(r.action, "skipped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("installBrokerGates (Pillar 3, opt-in)", () => {
  it("wires PreToolUse gate-egress (Bash) + gate-fs (Write|Edit|NotebookEdit), idempotently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-broker-gate-"));
    try {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      const r1 = await installBrokerGates(dir);
      assert.equal(r1.action, "created");
      const s = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf-8"));
      const groups = s.hooks.PreToolUse;
      assert.equal(groups.length, 2);
      const egress = groups.find((g: { matcher: string }) => g.matcher === "Bash");
      const fs = groups.find((g: { matcher: string }) => g.matcher === "Write|Edit|NotebookEdit");
      assert.ok(egress.hooks[0].command.endsWith("gate-egress"));
      assert.ok(fs.hooks[0].command.endsWith("gate-fs"));

      const r2 = await installBrokerGates(dir);
      assert.equal(r2.action, "unchanged");
      const s2 = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf-8"));
      assert.equal(s2.hooks.PreToolUse.length, 2, "no duplicate groups on re-run");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds only the missing gate when one is already wired", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-broker-gate2-"));
    try {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(
        join(dir, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              { matcher: "Bash", hooks: [{ type: "command", command: "kit gate-egress" }] },
            ],
          },
        }),
      );
      const r = await installBrokerGates(dir);
      assert.equal(r.action, "updated");
      const s = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf-8"));
      assert.equal(s.hooks.PreToolUse.length, 2);
      assert.ok(
        s.hooks.PreToolUse.some((g: { hooks: { command: string }[] }) =>
          g.hooks[0].command.endsWith("gate-fs"),
        ),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips when no Claude Code project is present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-broker-gate3-"));
    try {
      assert.equal((await installBrokerGates(dir)).action, "skipped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("kitGateInvocation / kitGateArgv (prefer the self-healing wrapper)", () => {
  // The gate hook should point at the stable ~/.kit/bin/kit wrapper rather than
  // bake a volatile absolute node path into every agent's config: the wrapper
  // restores the tool PATH a non-login hook shell drops (so triage's python3/git
  // resolve) and is the single place kit refreshes if node moves — one stable path
  // vs. a per-agent node path that can go stale and make the hook fail to spawn.
  const withHome = (fn: (home: string) => void) => {
    const prev = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "kit-gatehome-"));
    process.env.HOME = home;
    try {
      fn(home);
    } finally {
      if (prev === undefined) delete process.env.HOME;
      else process.env.HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  };

  it(
    "prefers the self-healing wrapper when one is present",
    { skip: process.platform === "win32" },
    () => {
      withHome((home) => {
        const wrapper = kitWrapperPath(home);
        mkdirSync(kitBinDir(home), { recursive: true });
        writeFileSync(wrapper, '#!/bin/sh\nexec kit "$@"\n');
        assert.equal(kitGateInvocation(), `${wrapper} gate-bash`);
        assert.deepEqual(kitGateArgv(), [wrapper, "gate-bash"]);
      });
    },
  );

  it(
    "falls back to an absolute node+cli when no wrapper exists",
    { skip: process.platform === "win32" },
    () => {
      withHome(() => {
        // fresh HOME → no ~/.kit/bin/kit → must use the resolved node+cli form, never a bare `kit`
        const inv = kitGateInvocation();
        assert.ok(inv.startsWith(process.execPath), "starts with the absolute node path");
        assert.ok(inv.endsWith("gate-bash"));
        assert.ok(!inv.startsWith("kit "), "never the PATH-dependent bare form when cli resolves");
        const argv = kitGateArgv();
        assert.equal(argv[0], process.execPath);
        assert.equal(argv[argv.length - 1], "gate-bash");
      });
    },
  );
});

describe("installInstallGateCodex", () => {
  it("appends a valid [[hooks.PreToolUse]] block to .codex/config.toml, preserving content, idempotent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-codexgate-"));
    try {
      mkdirSync(join(dir, ".codex"), { recursive: true });
      writeFileSync(join(dir, ".codex", "config.toml"), '# my codex config\nmodel = "gpt-5"\n');
      const r1 = await installInstallGateCodex(dir);
      assert.equal(r1.action, "updated");
      const txt = readFileSync(join(dir, ".codex", "config.toml"), "utf-8");
      assert.ok(txt.includes("# my codex config"), "preserves existing content/comments");
      assert.ok(txt.includes("[[hooks.PreToolUse]]"));
      assert.ok(txt.includes("gate-bash"));
      const { parse } = await import("smol-toml");
      const cfg = parse(txt) as { hooks: { PreToolUse: { matcher: string }[] } };
      assert.ok(Array.isArray(cfg.hooks.PreToolUse), "valid TOML, array-of-tables");
      assert.equal(cfg.hooks.PreToolUse[0].matcher, "^Bash$");
      const r2 = await installInstallGateCodex(dir);
      assert.equal(r2.action, "unchanged");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips when no Codex project is present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-codexgate2-"));
    try {
      assert.equal((await installInstallGateCodex(dir)).action, "skipped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("installInstallGateAmazonQ", () => {
  it("adds hooks.preToolUse to existing agent JSONs, idempotently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-qgate-"));
    try {
      mkdirSync(join(dir, ".amazonq", "cli-agents"), { recursive: true });
      writeFileSync(
        join(dir, ".amazonq", "cli-agents", "default.json"),
        JSON.stringify({ name: "default", tools: ["execute_bash"] }),
      );
      const r1 = await installInstallGateAmazonQ(dir);
      assert.equal(r1.action, "updated");
      const a = JSON.parse(
        readFileSync(join(dir, ".amazonq", "cli-agents", "default.json"), "utf-8"),
      );
      assert.equal(a.name, "default", "preserves existing agent fields");
      assert.equal(a.hooks.preToolUse[0].matcher, "execute_bash");
      assert.ok(a.hooks.preToolUse[0].command.endsWith("gate-bash"));
      const r2 = await installInstallGateAmazonQ(dir);
      assert.equal(r2.action, "unchanged");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips when no Amazon Q agent config is present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-qgate2-"));
    try {
      assert.equal((await installInstallGateAmazonQ(dir)).action, "skipped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("installInstallGateKiro", () => {
  it("adds hooks.preToolUse to existing .kiro/agents JSONs, idempotently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-kirogate-"));
    try {
      mkdirSync(join(dir, ".kiro", "agents"), { recursive: true });
      writeFileSync(
        join(dir, ".kiro", "agents", "default.json"),
        JSON.stringify({ name: "default", tools: ["execute_bash"] }),
      );
      const r1 = await installInstallGateKiro(dir);
      assert.equal(r1.action, "updated");
      const a = JSON.parse(readFileSync(join(dir, ".kiro", "agents", "default.json"), "utf-8"));
      assert.equal(a.name, "default", "preserves existing agent fields");
      assert.equal(a.hooks.preToolUse[0].matcher, "execute_bash");
      assert.ok(a.hooks.preToolUse[0].command.endsWith("gate-bash"));
      const r2 = await installInstallGateKiro(dir);
      assert.equal(r2.action, "unchanged");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips when no Kiro agent config is present (no false-green)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-kirogate2-"));
    try {
      assert.equal((await installInstallGateKiro(dir)).action, "skipped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("installInstallGateDroid", () => {
  it("writes a PreToolUse Execute gate to .factory/hooks.json, idempotently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-droidgate-"));
    try {
      mkdirSync(join(dir, ".factory"), { recursive: true });
      const r1 = await installInstallGateDroid(dir);
      assert.equal(r1.action, "created");
      const s = JSON.parse(readFileSync(join(dir, ".factory", "hooks.json"), "utf-8"));
      const groups = s.hooks.PreToolUse;
      assert.ok(Array.isArray(groups) && groups.length === 1);
      // the ONE adaptation vs Claude/Codex: matcher is "Execute", not "Bash"
      assert.equal(groups[0].matcher, "Execute");
      assert.ok(groups[0].hooks[0].command.endsWith("gate-bash"));

      const r2 = await installInstallGateDroid(dir);
      assert.equal(r2.action, "unchanged");
      const s2 = JSON.parse(readFileSync(join(dir, ".factory", "hooks.json"), "utf-8"));
      assert.equal(s2.hooks.PreToolUse.length, 1, "no duplicate group on re-run");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a legacy .factory/hooks/hooks.json gate as already-wired", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-droidgate-legacy-"));
    try {
      mkdirSync(join(dir, ".factory", "hooks"), { recursive: true });
      writeFileSync(
        join(dir, ".factory", "hooks", "hooks.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              { matcher: "Execute", hooks: [{ type: "command", command: "/x/cli.js gate-bash" }] },
            ],
          },
        }),
      );
      const r = await installInstallGateDroid(dir);
      assert.equal(r.action, "unchanged");
      // must NOT create a second scope-root file
      assert.equal(existsSync(join(dir, ".factory", "hooks.json")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips when no Factory Droid project is present (no false-green)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-droidgate2-"));
    try {
      assert.equal((await installInstallGateDroid(dir)).action, "skipped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("installInstallGateAugment", () => {
  it("writes a PreToolUse launch-process gate to .augment/settings.json, idempotently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-auggate-"));
    try {
      mkdirSync(join(dir, ".augment"), { recursive: true });
      const r1 = await installInstallGateAugment(dir);
      assert.equal(r1.action, "created");
      const s = JSON.parse(readFileSync(join(dir, ".augment", "settings.json"), "utf-8"));
      const groups = s.hooks.PreToolUse;
      assert.ok(Array.isArray(groups) && groups.length === 1);
      // the one adaptation: Augment's shell tool is "launch-process"
      assert.equal(groups[0].matcher, "launch-process");
      assert.ok(groups[0].hooks[0].command.endsWith("gate-bash"));

      const r2 = await installInstallGateAugment(dir);
      assert.equal(r2.action, "unchanged");
      const s2 = JSON.parse(readFileSync(join(dir, ".augment", "settings.json"), "utf-8"));
      assert.equal(s2.hooks.PreToolUse.length, 1, "no duplicate group on re-run");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects via a bare .augment-guidelines file too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-auggate-g-"));
    try {
      writeFileSync(join(dir, ".augment-guidelines"), "# guidelines\n");
      const r = await installInstallGateAugment(dir);
      assert.equal(r.action, "created");
      assert.ok(existsSync(join(dir, ".augment", "settings.json")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips when no Augment project is present (no false-green)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-auggate2-"));
    try {
      assert.equal((await installInstallGateAugment(dir)).action, "skipped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("installInstallGateAntigravity", () => {
  it("writes a PreToolUse run_command gate to .agents/hooks.json, idempotently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-antigrav-"));
    try {
      mkdirSync(join(dir, ".agents"), { recursive: true });
      const r1 = await installInstallGateAntigravity(dir);
      assert.equal(r1.action, "created");
      const s = JSON.parse(readFileSync(join(dir, ".agents", "hooks.json"), "utf-8"));
      const groups = s.hooks.PreToolUse;
      assert.ok(Array.isArray(groups) && groups.length === 1);
      assert.equal(groups[0].matcher, "run_command");
      assert.ok(groups[0].hooks[0].command.endsWith("gate-bash"));

      const r2 = await installInstallGateAntigravity(dir);
      assert.equal(r2.action, "unchanged");
      const s2 = JSON.parse(readFileSync(join(dir, ".agents", "hooks.json"), "utf-8"));
      assert.equal(s2.hooks.PreToolUse.length, 1, "no duplicate group on re-run");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips when no Antigravity (.agents/) project is present (no false-green)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-antigrav2-"));
    try {
      assert.equal((await installInstallGateAntigravity(dir)).action, "skipped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mergeAiderRead (conf.yml read: merge, no YAML dep)", () => {
  it("no-ops when CONVENTIONS.md is already referenced", () => {
    const r = mergeAiderRead("read:\n  - CONVENTIONS.md\n");
    assert.equal(r.changed, false);
  });
  it("creates a read block when the key is absent", () => {
    const r = mergeAiderRead("model: gpt-4\n");
    assert.equal(r.changed, true);
    assert.ok(r.next.includes("read:\n  - CONVENTIONS.md"));
    assert.ok(r.next.includes("model: gpt-4"), "preserves other keys");
  });
  it("promotes a scalar read: to a two-item block list", () => {
    const r = mergeAiderRead("read: OTHER.md\n");
    assert.equal(r.changed, true);
    assert.ok(r.next.includes("- OTHER.md"));
    assert.ok(r.next.includes("- CONVENTIONS.md"));
  });
  it("appends to an existing block list, matching indent", () => {
    const r = mergeAiderRead("read:\n  - OTHER.md\n");
    assert.equal(r.changed, true);
    assert.ok(/read:\n {2}- CONVENTIONS\.md\n {2}- OTHER\.md|read:\n {2}- OTHER\.md/.test(r.next));
    assert.ok(r.next.includes("- CONVENTIONS.md"));
  });
  it("refuses to text-edit a flow list (manual instead of corrupting)", () => {
    const r = mergeAiderRead("read: [a.md, b.md]\n");
    assert.equal(r.changed, false);
    assert.equal(r.manual, true);
  });
});

describe("installAiderRules (bespoke: CONVENTIONS.md + conf.yml)", () => {
  it("writes the kit block AND wires read: CONVENTIONS.md, idempotently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-aider-"));
    try {
      writeFileSync(join(dir, ".aider.conf.yml"), "model: gpt-4\n");
      const r1 = await installAiderRules(dir);
      assert.notEqual(r1.action, "failed");
      const conv = readFileSync(join(dir, "CONVENTIONS.md"), "utf-8");
      assert.ok(conv.includes("kit triage"), "kit block written to CONVENTIONS.md");
      const conf = readFileSync(join(dir, ".aider.conf.yml"), "utf-8");
      assert.ok(conf.includes("CONVENTIONS.md"), "read: CONVENTIONS.md wired");
      assert.ok(conf.includes("model: gpt-4"), "preserves existing conf");

      const r2 = await installAiderRules(dir);
      assert.equal(r2.action, "unchanged");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects via a bare .aider.chat.history.md and creates both files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-aider2-"));
    try {
      writeFileSync(join(dir, ".aider.chat.history.md"), "# aider chat started at x\n");
      const r = await installAiderRules(dir);
      assert.notEqual(r.action, "failed");
      assert.ok(existsSync(join(dir, "CONVENTIONS.md")));
      assert.ok(readFileSync(join(dir, ".aider.conf.yml"), "utf-8").includes("CONVENTIONS.md"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips when no Aider project is present (no false-green)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-aider3-"));
    try {
      const r = await installAiderRules(dir);
      assert.equal(r.detail, "no Aider project detected");
      assert.equal(existsSync(join(dir, "CONVENTIONS.md")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("installInstallGateGemini", () => {
  it("wires a BeforeTool hook into .gemini/settings.json, idempotently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-geminigate-"));
    try {
      mkdirSync(join(dir, ".gemini"), { recursive: true });
      const r1 = await installInstallGateGemini(dir);
      assert.equal(r1.action, "created");
      const s = JSON.parse(readFileSync(join(dir, ".gemini", "settings.json"), "utf-8"));
      assert.ok(s.hooks.BeforeTool[0].hooks[0].command.endsWith("gate-bash"));
      assert.equal((await installInstallGateGemini(dir)).action, "unchanged");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("skips when no Gemini project is present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-geminigate2-"));
    try {
      assert.equal((await installInstallGateGemini(dir)).action, "skipped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("installInstallGateCursor", () => {
  it("wires a beforeShellExecution hook into .cursor/hooks.json, idempotently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-cursorgate-"));
    try {
      mkdirSync(join(dir, ".cursor"), { recursive: true });
      const r1 = await installInstallGateCursor(dir);
      assert.equal(r1.action, "created");
      const c = JSON.parse(readFileSync(join(dir, ".cursor", "hooks.json"), "utf-8"));
      assert.equal(c.version, 1);
      assert.ok(c.hooks.beforeShellExecution[0].command.endsWith("gate-bash"));
      assert.equal((await installInstallGateCursor(dir)).action, "unchanged");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("skips when no Cursor project is present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-cursorgate2-"));
    try {
      assert.equal((await installInstallGateCursor(dir)).action, "skipped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("installInstallGateOpenCode", () => {
  it("writes a tool.execute.before plugin that loads as a module, idempotently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-ocgate-"));
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true });
      const r1 = await installInstallGateOpenCode(dir);
      assert.equal(r1.action, "created");
      const pluginPath = join(dir, ".opencode", "plugin", "kit-install-gate.js");
      assert.ok(existsSync(pluginPath));
      const body = readFileSync(pluginPath, "utf-8");
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
  it("skips when no OpenCode project is present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-ocgate3-"));
    try {
      assert.equal((await installInstallGateOpenCode(dir)).action, "skipped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("installInstallGateCline", () => {
  it("writes an executable .clinerules/hooks/PreToolUse shim, idempotently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-clinegate-"));
    try {
      mkdirSync(join(dir, ".clinerules"), { recursive: true });
      const r1 = await installInstallGateCline(dir);
      assert.equal(r1.action, "created");
      const hookPath = join(dir, ".clinerules", "hooks", "PreToolUse");
      assert.ok(existsSync(hookPath));
      const body = readFileSync(hookPath, "utf-8");
      assert.ok(body.startsWith("#!/bin/sh"), "is a shell script");
      assert.ok(body.includes("gate-bash --format cline"), "invokes the cline-format gate");
      // Executable bit set (POSIX) — Cline runs the file directly.
      if (process.platform !== "win32") {
        assert.ok((statSync(hookPath).mode & 0o111) !== 0, "has the executable bit");
      }
      assert.equal((await installInstallGateCline(dir)).action, "unchanged");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("detects a .cline project dir too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-clinegate2-"));
    try {
      mkdirSync(join(dir, ".cline"), { recursive: true });
      assert.equal((await installInstallGateCline(dir)).action, "created");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("skips when no Cline project is present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-clinegate3-"));
    try {
      assert.equal((await installInstallGateCline(dir)).action, "skipped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gateLiveness (enforcement floor must prove it exists)", () => {
  const settings = (cmds: string[]) =>
    JSON.stringify({
      hooks: {
        PreToolUse: cmds.map((c) => ({ matcher: "x", hooks: [{ type: "command", command: c }] })),
      },
    });
  const mark = (dir: string) => writeFileSync(join(dir, ".claude/.kit-gates-installed"), "x\n");

  function repo(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "kit-gatelive-"));
    try {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("no install marker (fresh checkout / CI) → everInstalled:false, no false alarm", () => {
    repo((dir: string) => {
      // the committed block is present, but the machine-local marker is NOT — this
      // is the normal clone/CI case that must NOT fail.
      writeFileSync(join(dir, "CLAUDE.md"), KIT_BLOCK_BEGIN + "\n" + KIT_BLOCK_END + "\n");
      assert.equal(gateLiveness(dir).everInstalled, false);
    });
  });

  it("marker present + both gates wired → all true", () => {
    repo((dir: string) => {
      mark(dir);
      writeFileSync(
        join(dir, ".claude/settings.json"),
        settings(["~/.kit/bin/kit gate-bash", "~/.kit/bin/kit gate-env"]),
      );
      assert.deepEqual(gateLiveness(dir), {
        everInstalled: true,
        installGate: true,
        envGate: true,
        egressGate: false,
      });
    });
  });

  it("marker present but env-gate vanished → the silent-degradation case", () => {
    repo((dir: string) => {
      mark(dir);
      writeFileSync(join(dir, ".claude/settings.json"), settings(["~/.kit/bin/kit gate-bash"]));
      const live = gateLiveness(dir);
      assert.equal(live.everInstalled, true);
      assert.equal(live.installGate, true);
      assert.equal(live.envGate, false);
    });
  });

  it("marker present but settings.json unparseable → both gates read absent (a problem)", () => {
    repo((dir: string) => {
      mark(dir);
      writeFileSync(join(dir, ".claude/settings.json"), "{ not json");
      const live = gateLiveness(dir);
      assert.equal(live.everInstalled, true);
      assert.equal(live.installGate, false);
      assert.equal(live.envGate, false);
    });
  });

  it("markGatesInstalled writes the marker gateLiveness reads", async () => {
    const { markGatesInstalled } = await import("./agent-config.js");
    repo((dir: string) => {
      assert.equal(gateLiveness(dir).everInstalled, false);
      markGatesInstalled(dir);
      assert.equal(gateLiveness(dir).everInstalled, true);
    });
  });
});
