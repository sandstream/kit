/**
 * `kit triage skill <plugin>` on a Claude Code mod: hooks.json names JavaScript modules
 * (`{"modules": ["./x.mjs"]}`) that Claude Code loads in its own process.
 *
 * plugin_scan.py read that object as a hook event called "modules": it printed
 * `modules hook (matcher '*')` and "0 hook command(s)", and never said where the module hooks in.
 * Anthropic's claude-code-playground `blast-radius` mod holds the agent's Bash calls through a
 * `tool.call` handler; kit reported it as matching every tool, with no warning.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { rmTemp } from "./temp-cleanup.test-support.js";
import { warmPython } from "./python-warmup.test-support.js";

before(() => warmPython());

const exec = promisify(execFile);
const TRIAGE_PY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "skills",
  "triage",
  "scripts",
  "triage.py",
);
const MANIFEST = JSON.stringify({ name: "probe", version: "0.1.0" });
const MODULES = JSON.stringify({ modules: ["./probe.mjs"] });

async function triagePlugin(
  t: { after(fn: () => void): void; skip(m: string): void },
  files: Record<string, string>,
): Promise<string | null> {
  const root = mkdtempSync(join(tmpdir(), "kit-triage-plugin-modules-"));
  t.after(() => rmTemp(root));
  const dir = join(root, "plugin");
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  try {
    return (await exec("python3", ["-I", TRIAGE_PY, "skill", dir], { timeout: 30_000 })).stdout;
  } catch (err) {
    const e = err as { code?: string | number; stdout?: string };
    if (e.code === "ENOENT") {
      t.skip(
        "python3 not installed — plugin_scan.py's mod module report is NOT verified in this run",
      );
      return null;
    }
    return e.stdout ?? "";
  }
}

describe("triage skill <plugin>: the modules of a Claude Code mod", () => {
  it("names the tool a tool.call module holds, instead of an invented '*' matcher", async (t) => {
    const out = await triagePlugin(t, {
      ".claude-plugin/plugin.json": MANIFEST,
      "hooks/hooks.json": MODULES,
      "hooks/probe.mjs": [
        "export function register(on) {",
        '  on("tool.call", { tool: "Bash" }, async ($, e, next) => {',
        '    await $.process.run(["git", "status", "--porcelain"], { timeoutMs: 5000 });',
        "    return next();",
        "  });",
        '  on("ui.render", { component: "Pane" }, ($, e, next) => next());',
        '  on("ui.render", { component: "AbovePrompt" }, ($, e, next) => next());',
        "}",
      ].join("\n"),
    });
    if (out === null) return;
    assert.doesNotMatch(out, /modules hook/, out);
    assert.match(out, /plugin registers 1 hook module\(s\)/);
    assert.match(
      out,
      /hooks\/probe\.mjs: tool\.call hook on Bash -- runs inside Claude Code before the agent's Bash calls and can deny or rewrite them/,
    );
    assert.equal(out.match(/hooks\/probe\.mjs: ui\.render hook/g)?.length, 1, "one line per event");
    assert.match(out, /hooks\/probe\.mjs: starts processes \(\$\.process\.run\)/);
  });

  it("warns on a tool.call module with no tool filter, which sees every tool call", async (t) => {
    const out = await triagePlugin(t, {
      ".claude-plugin/plugin.json": MANIFEST,
      "hooks/hooks.json": MODULES,
      "hooks/probe.mjs":
        'export function register(on) { on("tool.call", {}, ($, e, next) => next()); }\n',
    });
    if (out === null) return;
    assert.match(
      out,
      /tool\.call hook on every tool -- runs inside Claude Code before the agent's Read, Bash/,
    );
  });

  it("refuses to read a module outside the plugin", async (t) => {
    const out = await triagePlugin(t, {
      ".claude-plugin/plugin.json": MANIFEST,
      "hooks/hooks.json": JSON.stringify({ modules: ["../../outside.mjs"] }),
    });
    if (out === null) return;
    assert.match(
      out,
      /hook module \.\.\/\.\.\/outside\.mjs in hooks\/hooks\.json lies outside the plugin directory/,
    );
  });
});
