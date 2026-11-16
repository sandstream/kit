import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { decideBashGate, parseInstallCommand } from "./install-gate.js";
import { TRIAGE_LOG_FILE } from "./triage-receipt.js";

const made: string[] = [];
function project(manifest: unknown): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kit-bare-")));
  made.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest),
  );
  return dir;
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function receipt(dir: string, name: string, ageDays = 0, target = name): void {
  const timestamp = new Date(Date.now() - ageDays * 86_400_000).toISOString();
  const line = JSON.stringify({ timestamp, type: "npm", target, sandbox: false, granter: "t" });
  writeFileSync(join(dir, TRIAGE_LOG_FILE), line + "\n", { flag: "a" });
}

// The command tokenizer reads a backslash as an escape, so a Windows path in a command is written with
// forward slashes, which Windows accepts too.
const fwd = (dir: string): string => dir.replace(/\\/g, "/");

const skill = { dependencies: { "axe-core": "4.10.3" }, devDependencies: { playwright: "1.58.0" } };

describe("a bare install of a manifest that no commit gate covers", () => {
  it("is blocked until every direct dependency has a fresh triage receipt", async () => {
    const dir = project(skill);
    const verdict = await decideBashGate("npm install --ignore-scripts", undefined, dir);
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /axe-core/);
    assert.match(verdict.reason, /playwright/);
    assert.match(verdict.reason, /kit triage npm/);
  });

  it("names only the dependencies that still lack a receipt", async () => {
    const dir = project(skill);
    receipt(dir, "axe-core");
    const verdict = await decideBashGate("npm install", undefined, dir);
    assert.equal(verdict.block, true);
    assert.doesNotMatch(verdict.reason, /axe-core/);
    assert.match(verdict.reason, /playwright/);
  });

  it("passes when every direct dependency has a fresh receipt", async () => {
    const dir = project(skill);
    receipt(dir, "axe-core");
    receipt(dir, "playwright");
    assert.equal((await decideBashGate("npm install", undefined, dir)).block, false);
  });

  it("reads a receipt whose target carries a version", async () => {
    const dir = project(skill);
    receipt(dir, "axe-core", 0, "axe-core@4.10.3");
    receipt(dir, "playwright", 0, "playwright@1.58.0");
    assert.equal((await decideBashGate("npm ci", undefined, dir)).block, false);
  });

  it("treats a receipt older than seven days as missing", async () => {
    const dir = project(skill);
    receipt(dir, "axe-core", 8);
    receipt(dir, "playwright");
    const verdict = await decideBashGate("npm install", undefined, dir);
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /axe-core/);
  });

  it("counts optionalDependencies too", async () => {
    const dir = project({ optionalDependencies: { fsevents: "2.3.2" } });
    const verdict = await decideBashGate("npm install", undefined, dir);
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /fsevents/);
  });

  for (const command of [
    "npm ci",
    "npm i",
    "npm update",
    "pnpm install",
    "yarn install",
    "yarn",
    "bun install",
  ]) {
    it(`covers \`${command}\``, async () => {
      const dir = project(skill);
      assert.equal((await decideBashGate(command, undefined, dir)).block, true);
    });
  }
});

describe("a bare install: which directory it installs", () => {
  it("follows a leading cd to the directory that is installed", async () => {
    const dir = project(skill);
    const verdict = await decideBashGate(
      `cd ${dir} && npm install --ignore-scripts`,
      undefined,
      tmpdir(),
    );
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /axe-core/);
  });

  it("follows --prefix to the directory that is installed", async () => {
    const dir = project(skill);
    const verdict = await decideBashGate(`npm install --prefix ${fwd(dir)}`, undefined, tmpdir());
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /axe-core/);
  });

  it("follows -C and the --prefix=<dir> form too", async () => {
    const dir = project(skill);
    for (const command of [
      `npm install -C ${fwd(dir)}`,
      `npm install --prefix=${fwd(dir)}`,
      `npm -C ${fwd(dir)} ci`,
    ]) {
      const verdict = await decideBashGate(command, undefined, tmpdir());
      assert.equal(verdict.block, true, command);
      assert.match(verdict.reason, /axe-core/, command);
    }
  });

  it("refuses a directory it cannot resolve instead of guessing", async () => {
    const dir = project(skill);
    for (const command of [
      'cd "$TARGET" && npm install',
      "cd $(mktemp -d) && npm install",
      "npm install && cd sub && npm install",
      "pushd sub && npm install",
    ]) {
      const verdict = await decideBashGate(command, undefined, dir);
      assert.equal(verdict.block, true, command);
      assert.match(verdict.reason, /directory/, command);
    }
  });
});

describe("a bare install: what the manifest declares", () => {
  it("refuses a manifest it cannot read", async () => {
    const dir = project("{ not json");
    const verdict = await decideBashGate("npm install", undefined, dir);
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /package\.json/);
  });

  it("refuses a git or URL dependency, which has no registry triage", async () => {
    for (const spec of [
      "git+https://example.invalid/x.git",
      "https://example.invalid/x.tgz",
      "owner/repo",
    ]) {
      const dir = project({ dependencies: { x: spec } });
      const verdict = await decideBashGate("npm install", undefined, dir);
      assert.equal(verdict.block, true, spec);
      assert.match(verdict.reason, /x/, spec);
    }
  });

  it("triages the real package behind an npm: alias", async () => {
    const dir = project({ dependencies: { alias: "npm:real-pkg@1.0.0" } });
    const verdict = await decideBashGate("npm install", undefined, dir);
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /real-pkg/);
  });

  it("skips local dependencies", async () => {
    const dir = project({ dependencies: { local: "file:../local", linked: "link:../l" } });
    assert.equal((await decideBashGate("npm install", undefined, dir)).block, false);
  });
});

describe("a bare install that stays allowed", () => {
  it("allows a manifest that git tracks, because check-deps gates it at commit", async () => {
    const dir = project(skill);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "package.json"], { cwd: dir });
    assert.equal((await decideBashGate("npm install", undefined, dir)).block, false);
  });

  it("allows a directory without a package.json", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "kit-bare-")));
    made.push(dir);
    mkdirSync(join(dir, "sub"));
    assert.equal((await decideBashGate("npm install", undefined, dir)).block, false);
  });

  it("allows a manifest with no dependencies", async () => {
    const dir = project({ name: "empty" });
    assert.equal((await decideBashGate("npm install", undefined, dir)).block, false);
  });

  it("does nothing when the caller gives no directory", async () => {
    assert.equal((await decideBashGate("npm install")).block, false);
  });

  it("leaves a global bare install alone", async () => {
    const dir = project(skill);
    assert.equal((await decideBashGate("npm install -g", undefined, dir)).block, false);
  });
});

describe("parseInstallCommand marks a bare install", () => {
  it("sets bareInstall for a package-less npm family install", () => {
    for (const command of ["npm install", "npm ci", "pnpm install", "yarn", "bun install"]) {
      assert.equal(parseInstallCommand(command).bareInstall, true, command);
    }
  });

  it("does not set bareInstall when a package is named or for a runner", () => {
    for (const command of ["npm install left-pad", "npx tsc", "echo hi"]) {
      assert.equal(parseInstallCommand(command).bareInstall, false, command);
    }
  });
});

describe("parseInstallCommand treats the value of --prefix and -C as a location, not a package", () => {
  it("does not triage a relative or drive-letter directory as a package", () => {
    for (const command of [
      "npm install --prefix sub",
      "npm install --prefix C:/Users/x/dir",
      "npm install -C ../elsewhere",
    ]) {
      const probe = parseInstallCommand(command);
      assert.deepEqual(probe.refs, [], command);
      assert.deepEqual(probe.unverifiable, [], command);
      assert.equal(probe.bareInstall, true, command);
    }
  });

  it("still triages the packages named next to it", () => {
    const probe = parseInstallCommand("npm install --prefix C:/Users/x/dir left-pad");
    assert.deepEqual(probe.refs, ["npm:left-pad"]);
    assert.deepEqual(probe.unverifiable, []);
    assert.equal(probe.bareInstall, false);
  });
});

describe("a package that shares its name with the --prefix or -C value is still triaged", () => {
  it("triages the package, not only the directory", () => {
    for (const command of [
      "npm install --prefix evil evil",
      "npm install -C evil evil",
      "npm install evil --prefix evil",
      "pnpm install -C evil evil",
    ]) {
      const probe = parseInstallCommand(command);
      assert.deepEqual(probe.refs, ["npm:evil"], command);
      assert.equal(probe.bareInstall, false, command);
    }
  });

  it("leaves pip alone: -C is --config-settings there, and a package after it is still gated", () => {
    const probe = parseInstallCommand("pip install -C evil evil");
    assert.deepEqual(probe.refs, ["pip:evil"]);
  });
});

describe("a bare install where the folder can redirect the registry", () => {
  const withReceipts = (manifest: unknown): string => {
    const dir = project(manifest);
    for (const name of Object.keys((manifest as { dependencies: object }).dependencies)) {
      receipt(dir, name);
    }
    return dir;
  };
  const lock = (resolved: string) =>
    JSON.stringify({
      lockfileVersion: 3,
      packages: { "": {}, "node_modules/axe-core": { version: "4.10.3", resolved } },
    });

  it("is blocked when the folder has its own .npmrc, even with every receipt present", async () => {
    const dir = withReceipts({ dependencies: { "axe-core": "4.10.3" } });
    writeFileSync(join(dir, ".npmrc"), "registry=https://example.invalid/\n");
    const verdict = await decideBashGate("npm install", undefined, dir);
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /\.npmrc/);
  });

  it("is blocked when the lockfile resolves a package from another registry", async () => {
    const dir = withReceipts({ dependencies: { "axe-core": "4.10.3" } });
    writeFileSync(join(dir, "package-lock.json"), lock("https://example.invalid/axe-core.tgz"));
    const verdict = await decideBashGate("npm ci", undefined, dir);
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /lockfile/);
  });

  it("passes when the lockfile resolves from the default registry", async () => {
    const dir = withReceipts({ dependencies: { "axe-core": "4.10.3" } });
    const resolved = "https://registry.npmjs.org/axe-core/-/axe-core-4.10.3.tgz";
    writeFileSync(join(dir, "package-lock.json"), lock(resolved));
    assert.equal((await decideBashGate("npm ci", undefined, dir)).block, false);
  });

  it("is blocked when the lockfile cannot be read", async () => {
    const dir = withReceipts({ dependencies: { "axe-core": "4.10.3" } });
    writeFileSync(join(dir, "package-lock.json"), "{ not json");
    assert.equal((await decideBashGate("npm ci", undefined, dir)).block, true);
  });
});

describe("a bare install that names its directory in more than one way", () => {
  it("refuses two directory flags, because npm and this gate could pick different ones", async () => {
    const dir = project(skill);
    for (const command of [
      "npm install --prefix a --prefix b",
      "npm install --prefix a -C b",
      "npm install -C a --prefix=b",
    ]) {
      const verdict = await decideBashGate(command, undefined, dir);
      assert.equal(verdict.block, true, command);
      assert.match(verdict.reason, /directory/, command);
    }
  });

  it("does not take the -C of another program as the install directory", async () => {
    const dir = project(skill);
    for (const command of [
      "git -C /elsewhere pull && npm install",
      "git -C /elsewhere pull; npm install --ignore-scripts",
      "tar -C /elsewhere -xf a.tar | npm install",
    ]) {
      const verdict = await decideBashGate(command, undefined, dir);
      assert.equal(verdict.block, true, command);
      assert.match(verdict.reason, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), command);
    }
  });

  it("refuses an environment or env -C that moves npm", async () => {
    const dir = project(skill);
    for (const command of [
      "NPM_CONFIG_PREFIX=/x npm install",
      "npm_config_prefix=/x npm install",
      "env -C /x npm install",
      "env --chdir=/x npm install",
    ]) {
      const verdict = await decideBashGate(command, undefined, dir);
      assert.equal(verdict.block, true, command);
      assert.match(verdict.reason, /directory/, command);
    }
  });

  it("follows pnpm --dir and yarn or bun --cwd", async () => {
    const dir = project(skill);
    for (const command of [
      `pnpm install --dir ${fwd(dir)}`,
      `yarn install --cwd ${fwd(dir)}`,
      `bun install --cwd ${fwd(dir)}`,
    ]) {
      const verdict = await decideBashGate(command, undefined, tmpdir());
      assert.equal(verdict.block, true, command);
      assert.match(verdict.reason, /axe-core/, command);
    }
  });

  it("does not read a --dir or --cwd value as a package, and keeps a package of that name", () => {
    for (const command of [
      "pnpm install --dir sub",
      "yarn install --cwd sub",
      "bun install --cwd sub",
    ]) {
      const probe = parseInstallCommand(command);
      assert.deepEqual(probe.refs, [], command);
      assert.equal(probe.bareInstall, true, command);
    }
    for (const [command, ref] of [
      ["pnpm add --dir evil evil", "npm:evil"],
      ["yarn add --cwd evil evil", "npm:evil"],
      ["bun add --cwd evil evil", "npm:evil"],
    ]) {
      assert.deepEqual(parseInstallCommand(command).refs, [ref], command);
    }
  });
});

describe("a bare install: segments and managers are read the way the shell does", () => {
  const triaged = (): string => {
    const dir = project({ dependencies: { "axe-core": "4.10.3" } });
    receipt(dir, "axe-core");
    return dir;
  };

  it("does not take the -C of a program before a single & as the install directory", async () => {
    const dir = project(skill);
    const verdict = await decideBashGate("git -C /elsewhere pull & npm install", undefined, dir);
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /bare install/);
  });

  it("reads the directory flags of a package manager named by path or in quotes", async () => {
    const dir = triaged();
    for (const command of [
      "/usr/bin/npm install --prefix a --prefix b",
      '"npm" install --prefix a --prefix b',
      "'/opt/node/bin/npm' install --prefix a --prefix b",
    ]) {
      const verdict = await decideBashGate(command, undefined, dir);
      assert.equal(verdict.block, true, command);
      assert.match(verdict.reason, /directory/, command);
    }
  });
});

describe("a bare install where another config file or lockfile can steer the install", () => {
  for (const file of [
    ".yarnrc",
    ".yarnrc.yml",
    "bunfig.toml",
    ".pnpmfile.cjs",
    ".pnpmfile.mjs",
    "pnpm-workspace.yaml",
    "bun.lock",
    "bun.lockb",
  ]) {
    it(`is blocked when the folder holds ${file}, even with every receipt present`, async () => {
      const dir = project({ dependencies: { "axe-core": "4.10.3" } });
      receipt(dir, "axe-core");
      writeFileSync(join(dir, file), "x\n");
      const verdict = await decideBashGate("npm install", undefined, dir);
      assert.equal(verdict.block, true);
      assert.ok(verdict.reason.includes(file), verdict.reason);
    });
  }
});

describe("a bare install: the directory comes from the tokens the gate parsed", () => {
  const withSub = (): { dir: string; sub: string } => {
    const dir = project({ name: "root" });
    const sub = join(dir, "x");
    mkdirSync(sub);
    writeFileSync(join(sub, "package.json"), JSON.stringify({ dependencies: { "axe-core": "1" } }));
    return { dir, sub };
  };

  it("reads --prefix after a quoted separator in an earlier command", async () => {
    const { dir, sub } = withSub();
    for (const command of [
      'echo "a & b" && npm install --prefix x',
      "echo 'a; b' ; npm install --prefix x",
      'printf "%s" "a|b" && npm install --prefix x',
      `echo "it's" && npm install --prefix x`,
    ]) {
      const verdict = await decideBashGate(command, undefined, dir);
      assert.equal(verdict.block, true, command);
      assert.ok(verdict.reason.includes(sub), `${command}: ${verdict.reason}`);
    }
  });

  it("refuses a directory value that still holds a shell metacharacter", async () => {
    const dir = project({ dependencies: { "axe-core": "4.10.3" } });
    receipt(dir, "axe-core");
    for (const command of ['npm install --prefix "x | y"', "npm install --prefix 'x;y'"]) {
      const verdict = await decideBashGate(command, undefined, dir);
      assert.equal(verdict.block, true, command);
      assert.match(verdict.reason, /directory flag/, command);
    }
  });

  it("refuses two bare installs in one command, because each has its own directory", async () => {
    const dir = project({ dependencies: { "axe-core": "4.10.3" } });
    receipt(dir, "axe-core");
    const verdict = await decideBashGate("npm install && npm install --prefix x", undefined, dir);
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /more than one/);
  });
});

describe("a bare install below a workspace root", () => {
  // npm, pnpm and bun read the registry config of a workspace root that lists the folder as a member.
  // A plain parent .npmrc is ignored when the folder has its own package.json, so only a root counts.
  const below = (levels: number): { root: string; dir: string } => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "kit-bare-root-")));
    made.push(root);
    let dir = root;
    for (let i = 0; i < levels; i++) dir = join(dir, `sub${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { "axe-core": "4.10.3" } }),
    );
    receipt(dir, "axe-core");
    return { root, dir };
  };
  const decide = (dir: string) => decideBashGate("npm install", undefined, dir);

  it("is blocked when the parent holds pnpm-workspace.yaml", async () => {
    const { root, dir } = below(1);
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'sub0'\n");
    const verdict = await decide(dir);
    assert.equal(verdict.block, true);
    assert.ok(verdict.reason.includes("workspace"), verdict.reason);
  });

  for (const workspaces of [["sub0"], { packages: ["sub0"] }]) {
    it(`is blocked when the parent package.json has workspaces as ${Array.isArray(workspaces) ? "a list" : "an object"}`, async () => {
      const { root, dir } = below(1);
      writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces }));
      const verdict = await decide(dir);
      assert.equal(verdict.block, true);
      assert.ok(verdict.reason.includes("workspace"), verdict.reason);
    });
  }

  it("is blocked when the root is two levels up", async () => {
    const { root, dir } = below(2);
    writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["sub0/sub1"] }));
    assert.equal((await decide(dir)).block, true);
  });

  it("is blocked when a parent package.json cannot be read", async () => {
    const { root, dir } = below(1);
    writeFileSync(join(root, "package.json"), "{ not json");
    assert.equal((await decide(dir)).block, true);
  });

  it("stays allowed when the parent has a package.json without workspaces and its own .npmrc", async () => {
    const { root, dir } = below(1);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "parent" }));
    writeFileSync(join(root, ".npmrc"), "registry=https://example.invalid/\n");
    const verdict = await decide(dir);
    assert.equal(verdict.block, false, verdict.reason);
  });
});
