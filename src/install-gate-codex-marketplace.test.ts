/**
 * `codex plugin marketplace add <source>` is the same trust decision as the Claude form, so the
 * gate triages it the same way (kit-research copybook-vs-kit, unslop-anything-vs-kit).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideBashGate, parseInstallCommand } from "./install-gate.js";

const probe = (command: string) => {
  const p = parseInstallCommand(command);
  return { isInstall: p.isInstall, refs: p.refs, unverifiable: p.unverifiable };
};

const TRIAGED = { isInstall: true, refs: ["github:owner/repo"], unverifiable: [] };

/** Every spelling an agent might use, for one agent CLI and its npm package. */
function spellings(agent: "claude" | "codex", pkg: string): string[] {
  return [
    `${agent} plugin marketplace add owner/repo`,
    `${agent} plugins marketplace add 'owner/repo'`,
    `"${agent}" plugin marketplace add "https://github.com/owner/repo"`,
    `/usr/local/bin/${agent} plugin marketplace add git@github.com:owner/repo.git`,
    `cd /tmp && ${agent} plugin marketplace add owner/repo`,
    `sh -c '${agent} plugin marketplace add owner/repo'`,
    `env FOO=1 ${agent} plugin marketplace add owner/repo`,
    `npx -y ${pkg} plugin marketplace add owner/repo`,
    `npx ${pkg}@1.2.3 plugin marketplace add owner/repo`,
  ];
}

describe("install gate: codex plugin marketplaces are triaged like claude's", () => {
  for (const [agent, pkg] of [
    ["claude", "@anthropic-ai/claude-code"],
    ["codex", "@openai/codex"],
  ] as const) {
    it(`triages the GitHub marketplace ${agent} adds, in every spelling`, () => {
      for (const command of spellings(agent, pkg)) {
        const p = probe(command);
        const repoRefs = p.refs.filter((ref) => ref.startsWith("github:"));
        assert.equal(p.isInstall, true, command);
        assert.deepEqual(repoRefs, TRIAGED.refs, command);
        assert.deepEqual(p.unverifiable, [], command);
      }
    });

    it(`fails closed on a ${agent} marketplace source it cannot triage`, () => {
      for (const source of ["https://gitlab.com/owner/repo", "https://example.com/m.json", "x"]) {
        const p = probe(`${agent} plugin marketplace add ${source}`);
        assert.equal(p.isInstall, true, source);
        assert.deepEqual(p.unverifiable, [`${agent}-plugin-marketplace:${source}`], source);
      }
      assert.deepEqual(probe(`${agent} plugin marketplace add`).unverifiable, [
        `${agent}-plugin-marketplace:<none>`,
      ]);
    });

    it(`blocks the ${agent} marketplace add when repo triage fails`, async () => {
      const checked: string[] = [];
      const verdict = await decideBashGate(`${agent} plugin marketplace add owner/repo`, {
        runTriage: async (type, target) => {
          checked.push(`${type}:${target}`);
          return { type, target, passed: false, output: "TRIAGE FAILED" };
        },
      });
      assert.equal(verdict.block, true);
      assert.deepEqual(checked, ["repo:https://github.com/owner/repo"]);
    });
  }

  it("reads the source after codex's --ref and --sparse values", () => {
    assert.deepEqual(probe("codex plugin marketplace add owner/repo --ref main"), TRIAGED);
    assert.deepEqual(probe("codex plugin marketplace add --ref main owner/repo"), TRIAGED);
    assert.deepEqual(
      probe(
        "codex plugin marketplace add --sparse .agents/plugins https://github.com/owner/repo.git",
      ),
      TRIAGED,
    );
  });

  it("leaves local marketplaces and commands that add no new source alone", () => {
    for (const command of [
      "codex plugin marketplace add ./local-marketplace-root",
      "codex plugin marketplace list",
      "codex plugin marketplace upgrade",
      "codex plugin marketplace upgrade copybook",
      "codex plugin marketplace remove copybook",
      "codex plugin add copybook@copybook",
      "codex exec 'plugin marketplace add owner/repo'",
    ]) {
      assert.deepEqual(probe(command), { isInstall: false, refs: [], unverifiable: [] }, command);
    }
  });
});
