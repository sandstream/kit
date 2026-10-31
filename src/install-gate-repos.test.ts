import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseInstallCommand } from "./install-gate.js";

const probe = (command: string) => {
  const p = parseInstallCommand(command);
  return { isInstall: p.isInstall, refs: p.refs, unverifiable: p.unverifiable };
};

describe("install gate: claude plugin installs are triaged like skills add", () => {
  it("triages the GitHub marketplace a plugin install adds, in every spelling", () => {
    for (const source of [
      "stilero/mods-marketplace",
      "https://github.com/stilero/mods-marketplace",
      "github.com/stilero/mods-marketplace",
      "git@github.com:stilero/mods-marketplace.git",
    ]) {
      assert.deepEqual(
        probe(`claude plugin install cache-thermo --marketplace ${source}`),
        { isInstall: true, refs: ["github:stilero/mods-marketplace"], unverifiable: [] },
        source,
      );
    }
    assert.deepEqual(probe("claude plugin install x --marketplace=stilero/mods-marketplace").refs, [
      "github:stilero/mods-marketplace",
    ]);
  });

  it("triages `claude plugin marketplace add`, including behind other commands", () => {
    assert.deepEqual(probe("claude plugin marketplace add stilero/mods-marketplace").refs, [
      "github:stilero/mods-marketplace",
    ]);
    assert.deepEqual(probe("cd /tmp && claude plugins marketplace add owner/repo").refs, [
      "github:owner/repo",
    ]);
    assert.deepEqual(probe("sh -c 'claude plugin marketplace add owner/repo'").refs, [
      "github:owner/repo",
    ]);
  });

  it("fails closed on a source it cannot triage as a GitHub repo", () => {
    for (const source of [
      "https://gitlab.com/owner/repo",
      "https://example.com/marketplace.json",
      "single-segment",
    ]) {
      const p = probe(`claude plugin marketplace add ${source}`);
      assert.equal(p.isInstall, true, source);
      assert.deepEqual(p.refs, [], source);
      assert.deepEqual(p.unverifiable, [`claude-plugin-marketplace:${source}`], source);
    }
    assert.deepEqual(probe("claude plugin marketplace add").unverifiable, [
      "claude-plugin-marketplace:<none>",
    ]);
  });

  it("leaves local marketplaces, already-added marketplaces and read-only subcommands alone", () => {
    for (const command of [
      "claude plugin marketplace add ./my-marketplace",
      "claude plugin install cache-thermo@mods-marketplace",
      "claude plugin list",
      "claude plugin validate plugins/cache-thermo",
      "claude --plugin-dir plugins/cache-thermo",
    ]) {
      assert.deepEqual(probe(command), { isInstall: false, refs: [], unverifiable: [] }, command);
    }
  });
});
