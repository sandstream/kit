/** Supported repository sources and Claude plugin marketplace behavior. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideBashGate, parseInstallCommand } from "./install-gate.js";

const probe = (command: string) => {
  const p = parseInstallCommand(command);
  return { isInstall: p.isInstall, refs: p.refs, unverifiable: p.unverifiable };
};

for (const subpath of [
  "@scope",
  "c%2B%2B",
  "c++",
  "%40scope",
  "sample%20skill",
  "%E6%97%A5",
  ".hidden",
]) {
  it(`triages the repository behind the valid subpath ${subpath}`, async () => {
    const source = `https://github.com/owner/repo/tree/main/skills/${subpath}`;
    const command = `npx skills add '${source}'`;
    const checked: string[] = [];
    const verdict = await decideBashGate(command, {
      runTriage: async (type, target) => {
        checked.push(`${type}:${target}`);
        return { type, target, passed: true, output: "TRIAGE PASSED" };
      },
    });
    assert.equal(verdict.block, false, command);
    assert.deepEqual(checked, ["npm:skills", "repo:https://github.com/owner/repo"]);
    assert.deepEqual(probe(command), {
      isInstall: true,
      refs: ["npm:skills", "github:owner/repo"],
      unverifiable: [],
    });
  });
}

it("triages skills repositories whose names end in .json", async () => {
  for (const source of ["owner/schema.json", "https://github.com/owner/schema.json"]) {
    const command = `npx skills add ${source}`;
    const checked: string[] = [];
    const verdict = await decideBashGate(command, {
      runTriage: async (type, target) => {
        checked.push(`${type}:${target}`);
        return { type, target, passed: true, output: "TRIAGE PASSED" };
      },
    });
    assert.equal(verdict.block, false, command);
    assert.deepEqual(checked, ["npm:skills", "repo:https://github.com/owner/schema.json"]);
    assert.deepEqual(probe(command), {
      isInstall: true,
      refs: ["npm:skills", "github:owner/schema.json"],
      unverifiable: [],
    });
  }
});

it("still refuses a marketplace JSON document URL", async () => {
  const command =
    "claude plugin marketplace add https://github.com/owner/repo/blob/main/marketplace.json";
  const verdict = await decideBashGate(command, {
    runTriage: async () => assert.fail("a marketplace document must not use repository triage"),
  });
  assert.equal(verdict.block, true);
  assert.deepEqual(probe(command).refs, []);
  assert.deepEqual(probe(command).unverifiable, [
    "claude-plugin-marketplace:https://github.com/owner/repo/blob/main/marketplace.json",
  ]);
});

for (const source of [
  "owner/repo",
  "owner/repo.git",
  "github.com/owner/repo",
  "https://github.com/owner/repo",
  "http://github.com/owner/repo",
  "https://www.github.com/owner/repo",
  "https://GITHUB.COM/owner/repo",
  "https://github.com:443/owner/repo",
  "https://github.com/owner/repo.git/",
  "https://github.com/owner/repo/tree/main/skills/example",
  "git@github.com:owner/repo.git",
  "ssh://git@github.com/owner/repo.git",
  "ssh://git@github.com:22/owner/repo.git",
  "git+ssh://git@github.com/owner/repo.git",
  "git+https://github.com/owner/repo.git",
  "git://github.com/owner/repo.git",
]) {
  it(`triages the correct repository for supported source ${source}`, async () => {
    for (const installer of ["npx skills add", "claude plugin marketplace add"]) {
      const command = `${installer} '${source}'`;
      const checked: string[] = [];
      const verdict = await decideBashGate(command, {
        runTriage: async (type, target) => {
          checked.push(`${type}:${target}`);
          return { type, target, passed: true, output: "TRIAGE PASSED" };
        },
      });
      assert.equal(verdict.block, false, command);
      assert.deepEqual(
        checked,
        installer.startsWith("npx")
          ? ["npm:skills", "repo:https://github.com/owner/repo"]
          : ["repo:https://github.com/owner/repo"],
        command,
      );
      assert.deepEqual(probe(command).unverifiable, [], command);
    }
  });
}

it("leaves explicit local sources alone and still checks the skills runner", async () => {
  for (const source of [
    ".",
    "..",
    "./local/repo",
    "../local/repo",
    "/local/repo",
    "~/local/repo",
  ]) {
    const skills = await decideBashGate(`npx skills add '${source}'`, {
      runTriage: async (type, target) => {
        assert.equal(type, "npm");
        assert.equal(target, "skills");
        return { type, target, passed: true, output: "TRIAGE PASSED" };
      },
    });
    assert.equal(skills.block, false, source);
    assert.deepEqual(
      skills.checked.map((v) => v.tool),
      ["npm:skills"],
      source,
    );
    const plugin = await decideBashGate(`claude plugin marketplace add '${source}'`, {
      runTriage: async () => assert.fail("local marketplaces need no external triage"),
    });
    assert.equal(plugin.block, false, source);
    assert.deepEqual(plugin.checked, [], source);
  }
});

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
