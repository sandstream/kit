/** Public gate checks for package runners and their actual child commands. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { decideBashGate, parseInstallCommand } from "./install-gate.js";
import type { GateDeps } from "./triage-gate.js";

it("respects known global option arities around npm exec", async () => {
  for (const options of [
    "--loglevel=error",
    "--loglevel error",
    "--location=project",
    "--location project",
    "-L project",
    "-C ./project",
  ]) {
    for (const runner of [`npm ${options} exec`, `npm exec ${options}`, `npx ${options}`]) {
      for (const source of ["owner/repo", "https://foreign.example/owner/repo"]) {
        const command = `${runner} --package=skills -- skills add ${source}`;
        const blocked = source.startsWith("https://foreign.example");
        const parsed = parseInstallCommand(command);
        assert.deepEqual(
          parsed.refs,
          blocked ? ["npm:skills"] : ["npm:skills", "github:owner/repo"],
        );
        assert.deepEqual(parsed.unverifiable, blocked ? [`repo-source:${source}`] : []);
        const checked: string[] = [];
        const verdict = await decideBashGate(command, {
          runTriage: async (type, target) => {
            checked.push(`${type}:${target}`);
            return { type, target, passed: true, output: "TRIAGE PASSED" };
          },
        });
        assert.equal(verdict.block, blocked, command);
        assert.deepEqual(
          checked,
          blocked ? [] : ["npm:skills", "repo:https://github.com/owner/repo"],
        );
      }
    }
  }
});

it("uses the executable basename without changing package identity", async () => {
  for (const executable of ["./node_modules/.bin/skills", "/opt/tools/skills", "tools/skills"]) {
    for (const packageName of ["skills", "other"]) {
      for (const [source, expectedRepo] of [
        ["https://foreign.example/owner/repo", false],
        ["owner/repo", true],
        ["./local/repo", false],
      ] as const) {
        const command = `npm exec --package=${packageName} -- ${executable} add ${source}`;
        const blocked = source.includes("foreign.example");
        const parsed = parseInstallCommand(command);
        const packageRef = `npm:${packageName}`;
        assert.deepEqual(
          parsed.refs,
          expectedRepo ? [packageRef, "github:owner/repo"] : [packageRef],
        );
        assert.deepEqual(parsed.unverifiable, blocked ? [`repo-source:${source}`] : []);
        const checked: string[] = [];
        const verdict = await decideBashGate(command, {
          runTriage: async (type, target) => {
            checked.push(`${type}:${target}`);
            return { type, target, passed: true, output: "TRIAGE PASSED" };
          },
        });
        assert.equal(verdict.block, blocked, command);
        assert.deepEqual(
          checked,
          blocked
            ? []
            : expectedRepo
              ? [packageRef, "repo:https://github.com/owner/repo"]
              : [packageRef],
        );
      }
    }
  }
});

it("does not confuse other executable paths with the skills installer", async () => {
  for (const executable of ["./skills/other", "/opt/skills-helper", "./node_modules/.bin/other"]) {
    const command = `npm exec --package=skills -- ${executable} add https://foreign.example/owner/repo`;
    assert.deepEqual(parseInstallCommand(command).refs, ["npm:skills"]);
    assert.deepEqual(parseInstallCommand(command).unverifiable, []);
    const verdict = await decideBashGate(command, {
      runTriage: async (type, target) => {
        assert.equal(type, "npm");
        assert.equal(target, "skills");
        return { type, target, passed: true, output: "TRIAGE PASSED" };
      },
    });
    assert.equal(verdict.block, false, command);
  }
});

it("refuses unresolved npm runner calls before package triage", async () => {
  for (const prefix of [
    "npm exec --package=skills --call",
    "npm exec --package=skills --call=",
    "npm exec --package=skills -c",
    "npx --package=skills --call",
    "npx --package=skills -c",
  ]) {
    const command = `${prefix}${prefix.endsWith("=") ? "" : " "}'skills add https://foreign.example/owner/repo'`;
    const parsed = parseInstallCommand(command);
    assert.deepEqual(parsed.refs, ["npm:skills"]);
    assert.ok(
      parsed.unverifiable.some((reason) => reason.startsWith("runner-command:")),
      command,
    );
    const verdict = await decideBashGate(command, {
      runTriage: async () => assert.fail("an unresolved call must not reach package triage"),
    });
    assert.equal(verdict.block, true, command);
    assert.deepEqual(verdict.checked, []);
    assert.match(verdict.reason, /runner-command:/);
  }
});

it("preserves literal child call flags and refuses even benign unresolved calls", async () => {
  const pass: GateDeps = {
    runTriage: async (type, target) => ({ type, target, passed: true, output: "TRIAGE PASSED" }),
  };
  const unresolved = await decideBashGate("npm exec --package=skills --call 'echo fixture'", pass);
  assert.equal(unresolved.block, true);
  assert.deepEqual(unresolved.checked, []);
  const child = await decideBashGate("npm exec --package=skills -- other --call fixture", pass);
  assert.equal(child.block, false);
  assert.deepEqual(
    child.checked.map(({ tool }) => tool),
    ["npm:skills"],
  );
});

const probe = (command: string) => {
  const p = parseInstallCommand(command);
  return { isInstall: p.isInstall, refs: p.refs, unverifiable: p.unverifiable };
};

it("finds npm exec after manager options with separate values", async () => {
  for (const command of [
    "npm --cache ./cache exec -p skills -- add https://foreign.example/owner/repo",
    "npm --cache install exec --package=skills -- env skills add https://foreign.example/owner/repo",
  ]) {
    const checked: string[] = [];
    const verdict = await decideBashGate(command, {
      runTriage: async (type, target) => {
        checked.push(`${type}:${target}`);
        return { type, target, passed: true, output: "TRIAGE PASSED" };
      },
    });
    assert.equal(verdict.block, true, command);
    assert.deepEqual(probe(command).refs, ["npm:skills"]);
    assert.deepEqual(probe(command).unverifiable, [
      "repo-source:https://foreign.example/owner/repo",
    ]);
    assert.deepEqual(checked, []);
  }
});

it("refuses unknown runner options instead of guessing their arity", async () => {
  for (const command of [
    "npx --unknown value skills add https://foreign.example/owner/repo",
    "npm exec --unknown value skills add https://foreign.example/owner/repo",
  ]) {
    const verdict = await decideBashGate(command, {
      runTriage: async (type, target) => ({
        type,
        target,
        passed: true,
        output: "TRIAGE PASSED",
      }),
    });
    assert.equal(verdict.block, true, command);
    assert.deepEqual(verdict.checked, []);
    assert.ok(probe(command).unverifiable.includes("runner-option:--unknown"));
  }
});

it("keeps registry redirects and env refusal boundaries separate from child flags", async () => {
  const pass: GateDeps = {
    runTriage: async (type, target) => ({ type, target, passed: true, output: "TRIAGE PASSED" }),
  };
  for (const command of [
    "npm_config_registry=https://foreign.example npm exec --package=skills -- env other",
    "npm exec --registry=https://foreign.example --package=skills -- env other",
    "npx --registry=https://foreign.example --package=skills env other",
  ]) {
    const verdict = await decideBashGate(command, pass);
    assert.equal(verdict.block, true, command);
    assert.match(verdict.reason, /alt-registry:/);
    assert.deepEqual(verdict.checked, []);
  }
  const benign = await decideBashGate("npm exec --package=skills -- env -i other", pass);
  assert.equal(benign.block, false);
  const unknown = await decideBashGate(
    "npm exec --package=skills -- env -S 'skills add owner/repo'",
    pass,
  );
  assert.equal(unknown.block, true);
  assert.deepEqual(unknown.checked, []);
  assert.ok(
    probe("npm exec --package=skills -- env -S 'skills add owner/repo'").unverifiable.includes(
      "wrapper-command:env split-string",
    ),
  );
});

for (const [child, blocked] of [
  ["env skills", true],
  ["/usr/bin/env skills", true],
  ["env -i FLAG=1 skills", true],
  ["env -u UNUSED skills", true],
  ["env --unset=UNUSED FLAG=1 skills", true],
  ["env -- env FLAG=1 skills", true],
  ["env other skills", false],
  ["env FLAG=skills other", false],
  ["env -u skills other", false],
  ["env -- other", false],
] as const) {
  it(`checks the actual env child in ${child}`, async () => {
    const command = `npm exec --package=skills -- ${child} add https://foreign.example/owner/repo`;
    const checked: string[] = [];
    const verdict = await decideBashGate(command, {
      runTriage: async (type, target) => {
        checked.push(`${type}:${target}`);
        return { type, target, passed: true, output: "TRIAGE PASSED" };
      },
    });
    assert.equal(verdict.block, blocked, command);
    assert.deepEqual(probe(command).refs, ["npm:skills"]);
    assert.deepEqual(
      probe(command).unverifiable,
      blocked ? ["repo-source:https://foreign.example/owner/repo"] : [],
    );
    assert.deepEqual(checked, blocked ? [] : ["npm:skills"]);
  });
}

it("retains GitHub and local source controls behind env", async () => {
  for (const [source, targets] of [
    ["https://github.com/owner/repo", ["npm:skills", "repo:https://github.com/owner/repo"]],
    ["./local/repo", ["npm:skills"]],
  ] as const) {
    const checked: string[] = [];
    const command = `npm exec --package=skills -- env skills add ${source}`;
    const verdict = await decideBashGate(command, {
      runTriage: async (type, target) => {
        checked.push(`${type}:${target}`);
        return { type, target, passed: true, output: "TRIAGE PASSED" };
      },
    });
    assert.equal(verdict.block, false, command);
    assert.deepEqual(checked, targets);
  }
});

for (const [prefix, packageName, blocked] of [
  ["npm exec -p skills --", "skills", true],
  ["npm exec -p=false skills --", "skills", true],
  ["npm --cache ./cache exec -p skills --", "skills", true],
  ["npm --cache install exec --package=skills -- env skills", "skills", true],
  ["npx -p=skills -- skills", "skills", true],
  ["npm exec --parseable skills --", "skills", true],
  ["npm -p exec skills --", "skills", true],
  ["npm exec -p other --", "other", false],
  ["npx -p skills -- other", "skills", false],
  ["npx -p skills -- skills", "skills", true],
  ["npx --package=skills -- skills", "skills", true],
  ["npm exec --package=skills -- other", "skills", false],
  ["npx other --package=skills", "other", false],
  ["npm exec -- other --package=skills", "other", false],
  ["npm exec other --package=skills --", "skills", false],
  ["npm exec -p --package skills -- skills", "skills", true],
] as const) {
  it(`respects the manager's argument rules for ${prefix}`, async () => {
    const command = `${prefix} add https://foreign.example/owner/repo`;
    const checked: string[] = [];
    const verdict = await decideBashGate(command, {
      runTriage: async (type, target) => {
        checked.push(`${type}:${target}`);
        return { type, target, passed: true, output: "TRIAGE PASSED" };
      },
    });
    assert.equal(verdict.block, blocked, command);
    assert.deepEqual(probe(command).refs, [`npm:${packageName}`]);
    assert.deepEqual(
      probe(command).unverifiable,
      blocked ? ["repo-source:https://foreign.example/owner/repo"] : [],
    );
    assert.deepEqual(checked, blocked ? [] : [`npm:${packageName}`]);
  });
}

for (const [runner, packages] of [
  ["npm exec", "--package=other --package=skills"],
  ["npm exec", "--package=skills --package=other"],
  ["npx", "-p other -p skills"],
  ["npx", "-p skills -p other"],
]) {
  for (const invoked of ["skills", "other"]) {
    it(`checks the invoked ${invoked} command with ${runner} ${packages}`, async () => {
      const command = `${runner} ${packages} -- ${invoked} add https://foreign.example/owner/repo`;
      const checked: string[] = [];
      const verdict = await decideBashGate(command, {
        runTriage: async (type, target) => {
          checked.push(`${type}:${target}`);
          return { type, target, passed: true, output: "TRIAGE PASSED" };
        },
      });
      if (invoked === "skills") {
        assert.equal(verdict.block, true, command);
        assert.deepEqual(checked, []);
        assert.deepEqual(probe(command).unverifiable, [
          "repo-source:https://foreign.example/owner/repo",
        ]);
        assert.match(verdict.reason, /unsupported repository source/);
      } else {
        assert.equal(verdict.block, false, command);
        assert.deepEqual(probe(command).unverifiable, []);
        assert.deepEqual(checked.sort(), ["npm:other", "npm:skills"]);
        assert.deepEqual(probe(command).refs.slice().sort(), ["npm:other", "npm:skills"]);
      }
    });
  }
}

it("keeps foreign source refusals across supported npm runners", async () => {
  const deps: GateDeps = {
    runTriage: async () => assert.fail("unsupported sources must not reach external triage"),
  };
  for (const installer of [
    "npx skills@latest add",
    "npx --package=skills skills add",
    "npm exec skills -- add",
    "pnpm dlx skills add",
    "yarn dlx skills add",
    "bunx skills add",
    "bun x skills add",
  ]) {
    const command = `${installer} https://other.example/owner/repo`;
    const verdict = await decideBashGate(command, deps);
    assert.equal(verdict.block, true, command);
    assert.match(verdict.reason, /unsupported repository source/);
    assert.match(verdict.reason, /https:\/\/other\.example\/owner\/repo/);
  }
});
