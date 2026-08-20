/**
 * The inventory command, driven end to end.
 *
 * `kit tools list` exists because nothing inventoried the CLIs an agent decides from (#500), so
 * the thing worth testing is the OUTPUT an operator and a machine read: a source for everything
 * installed, an explicit "not checked" rather than an implied pass, and a `--json` shape a script
 * can rely on.
 *
 * No registry is contacted: `--latest` is never passed, and the gate-side reader is cache-only by
 * construction. Each spawn walks the real PATH, so the assertions are about shape, not versions.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

function run(
  args: string[],
  env: Record<string, string> = {},
): { exitCode: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf-8",
    env: {
      ...process.env,
      KIT_HIDE_HOOK_SKIP_BANNER: "1",
      KIT_AUDIT_ANCHOR: "0",
      ...env,
    },
    timeout: 180_000,
  });
  return { exitCode: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("kit tools", () => {
  it("lists by default, with the header, a source column and the summary", () => {
    const r = run(["tools"]);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /kit tools list/);
    // Every machine running this suite has git, and it comes from somewhere.
    assert.match(r.stdout, /\bgit\b/);
    assert.match(r.stdout, /declared in \.kit\.toml/);
    // The currency hint must be present when --latest was NOT passed: silence would read as
    // "checked and fine", which is the defect this command was built for.
    assert.match(r.stdout, /Currency not checked/);
  });

  it("refuses an unknown subcommand instead of silently listing", () => {
    const r = run(["tools", "bogus"]);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /unknown subcommand: kit tools bogus/);
    assert.match(r.stderr, /kit tools list/);
  });

  it("emits a --json shape a script can rely on, with currency null until asked", () => {
    const r = run(["tools", "list", "--json"]);
    assert.equal(r.exitCode, 0, r.stderr);
    const out = JSON.parse(r.stdout) as {
      checkedCurrency: boolean;
      tools: Array<{
        name: string;
        declared: string | null;
        path: string | null;
        source: string | null;
        shimmed: boolean | null;
        installed: string | null;
        currency: unknown;
      }>;
    };
    assert.equal(out.checkedCurrency, false);
    assert.ok(Array.isArray(out.tools) && out.tools.length > 0);
    for (const t of out.tools) {
      assert.equal(typeof t.name, "string");
      assert.ok("declared" in t && "path" in t && "source" in t && "installed" in t);
      assert.equal(t.currency, null, `${t.name}: currency must be null without --latest`);
      if (t.path !== null) assert.ok(t.source, `${t.name}: a resolved path must carry a source`);
    }
    // stdout must be pure JSON — a machine reader is the point of the flag.
    assert.doesNotMatch(r.stdout, /kit tools list/);
  });

  it("prints paths only when asked, so the default stays readable", () => {
    const plain = run(["tools", "list"]);
    const withPaths = run(["tools", "list"], { KIT_TOOLS_PATHS: "1" });
    assert.equal(withPaths.exitCode, 0, withPaths.stderr);
    // Strip ANSI first: the path line is dim, so the escape sits between the indent and the `/`.
    const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
    const countSlashes = (s: string): number => (stripAnsi(s).match(/^\s{4,}\/\S+/gm) ?? []).length;
    assert.ok(
      countSlashes(withPaths.stdout) > countSlashes(plain.stdout),
      "KIT_TOOLS_PATHS=1 must add the resolved paths",
    );
  });
});
