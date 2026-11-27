/**
 * `kit check --category security` carries the two instruction-constraint rows (kit-research
 * shrink-anything-vs-kit): a rule naming a deleted file, and a rule line dropped since HEAD.
 * Both warn and never fail.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAgentConfig } from "./check-agent-config.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const GIT = [
  "-c",
  "user.name=kit",
  "-c",
  "user.email=kit@example.invalid",
  "-c",
  "commit.gpgsign=false",
];
const git = (root: string, ...args: string[]) =>
  assert.equal(spawnSync("git", ["-C", root, ...GIT, ...args]).status, 0, args.join(" "));

const RULES = "# Rules\n- Never edit `src/generated/schema.ts` by hand.\n- Never push to `main`.\n";

function project(t: { after(fn: () => void): void }): { root: string; home: string } {
  const base = mkdtempSync(join(tmpdir(), "kit-check-constraints-"));
  t.after(() => rmTemp(base));
  const root = join(base, "project");
  const home = join(base, "home");
  mkdirSync(join(root, "src", "generated"), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(root, "AGENTS.md"), RULES);
  writeFileSync(join(root, "src", "generated", "schema.ts"), "export const s = 1;\n");
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return { root, home };
}

const row = <T extends { name: string }>(rows: T[], name: string) =>
  rows.find((r) => r.name === name);

describe("kit check: instruction constraints", () => {
  it("passes both rows on a clean tree", async (t) => {
    const { root, home } = project(t);
    const rows = await checkAgentConfig(root, home, {});
    assert.equal(row(rows, "instruction rules naming missing code")?.status, "pass");
    assert.equal(row(rows, "instruction rules removed since HEAD")?.status, "pass");
  });

  it("warns on a rule naming a deleted file and on a dropped rule line", async (t) => {
    const { root, home } = project(t);
    rmSync(join(root, "src", "generated", "schema.ts"));
    writeFileSync(
      join(root, "AGENTS.md"),
      "# Rules\n- Never edit `src/generated/schema.ts` by hand.\n",
    );
    const rows = await checkAgentConfig(root, home, {});
    const missing = row(rows, "instruction rules naming missing code");
    assert.equal(missing?.status, "warn");
    assert.deepEqual(missing?.files, [
      "AGENTS.md:2 `src/generated/schema.ts` (deleted, still in git history)",
    ]);
    const removed = row(rows, "instruction rules removed since HEAD");
    assert.equal(removed?.status, "warn");
    assert.deepEqual(removed?.files, ["AGENTS.md:3 removed: - Never push to `main`."]);
  });
});
