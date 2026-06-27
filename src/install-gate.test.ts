import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseInstallCommand, decideBashGate } from "./install-gate.js";
import type { GateDeps } from "./triage-gate.js";
import type { TriageType } from "./triage.js";

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
