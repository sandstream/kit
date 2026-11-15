import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const CLI = fileURLToPath(new URL("./cli.js", import.meta.url));
const posix = process.platform !== "win32";

const AUDIT = JSON.stringify({
  vulnerabilities: {
    "axe-core": {
      name: "axe-core",
      severity: "high",
      via: [
        {
          source: 1,
          name: "axe-core",
          title: "Example advisory",
          url: "https://github.com/advisories/GHSA-2222-3333-4444",
          severity: "high",
        },
      ],
    },
  },
});
const OUTDATED = JSON.stringify({
  playwright: { current: "1.58.0", wanted: "1.58.0", latest: "2.0.0" },
});

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kit-hookctx-")));
  const bin = join(home, "bin");
  const calls = join(home, "npm-calls.log");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/sh\necho "$*" >> '${calls}'\ncase "$1" in\n  audit) echo '${AUDIT}'; exit 1;;\n  outdated) echo '${OUTDATED}'; exit 1;;\nesac\nexit 0\n`,
  );
  chmodSync(join(bin, "npm"), 0o755);
  const scripts = join(home, ".claude", "skills", "tillganglighet", "scripts");
  mkdirSync(join(scripts, "node_modules"), { recursive: true });
  writeFileSync(join(scripts, "package.json"), '{"dependencies":{"axe-core":"4.10.3"}}');
  writeFileSync(join(scripts, "package-lock.json"), '{"lockfileVersion":3}');
  const run = (extra: Record<string, string> = {}, cwd: string = home) =>
    spawnSync(process.execPath, [CLI, "hooks", "context"], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PATH: bin + delimiter + (process.env.PATH ?? ""),
        NO_COLOR: "1",
        ...extra,
      },
    });
  const npmCalls = () =>
    existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).length : 0;
  return { home, bin, calls, run, npmCalls };
}

function declare(title: string, body: (f: () => ReturnType<typeof fixture>) => void): void {
  describe(title, { skip: !posix }, () => {
    let current: ReturnType<typeof fixture>;
    before(() => {
      current = fixture();
    });
    after(() => rmSync(current.home, { recursive: true, force: true }));
    body(() => current);
  });
}

declare("kit hooks context reports skill dependencies", (f) => {
  const run = (extra: Record<string, string> = {}) => f().run(extra);
  const npmCalls = () => f().npmCalls();

  it("prints one plain line naming the skill, the vulnerability and the major behind", () => {
    const r = run();
    assert.equal(r.status, 0);
    const lines = r.stdout.split("\n").filter((l) => l.startsWith("kit: skill"));
    assert.equal(lines.length, 1, r.stdout + r.stderr);
    assert.match(lines[0], /tillganglighet/);
    assert.match(lines[0], /1 known vulnerability \(1 high\) in axe-core/);
    assert.match(lines[0], /playwright 1\.58\.0 \(latest 2\.0\.0\)/);
  });

  it("pins npm to the folder and turns workspaces off", () => {
    const logged = readFileSync(f().calls, "utf8");
    const lines = logged.split("\n").filter(Boolean);
    assert.ok(lines.length >= 2, logged);
    for (const line of lines) {
      assert.match(line, /--no-workspaces/);
      assert.match(line, /--prefix \S*tillganglighet\/scripts/);
    }
  });

  it("repeats the finding from the cache without asking npm again", () => {
    const before = npmCalls();
    const r = run();
    assert.equal(r.status, 0);
    assert.match(r.stdout, /kit: skill "tillganglighet"/);
    assert.equal(npmCalls(), before);
  });

  it("is silent when KIT_SKILL_DEPS_WATCH=0", () => {
    const r = run({ KIT_SKILL_DEPS_WATCH: "0" });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /kit: skill/);
  });
});

declare("kit hooks context with a broken or untrusted setup", (f) => {
  const run = (extra: Record<string, string> = {}) => f().run(extra);
  const npmCalls = () => f().npmCalls();
  it("exits 0 and says nothing when npm is not usable", () => {
    rmSync(join(f().home, ".kit"), { recursive: true, force: true });
    writeFileSync(join(f().bin, "npm"), "#!/bin/sh\nexit 127\n");
    const r = run();
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /kit: skill/);
  });

  it("does not cache a failed audit as clean: the next session asks again", () => {
    rmSync(join(f().home, ".kit"), { recursive: true, force: true });
    writeFileSync(
      join(f().bin, "npm"),
      `#!/bin/sh\necho "$1" >> '${f().calls}'\ncase "$1" in\n  audit) echo '{"error":{"code":"ENOTFOUND","summary":"offline"}}'; exit 1;;\nesac\nexit 0\n`,
    );
    const first = npmCalls();
    assert.doesNotMatch(run().stdout, /kit: skill/);
    const afterFirst = npmCalls();
    assert.ok(afterFirst > first);
    run();
    assert.ok(npmCalls() > afterFirst, "an error must not be cached as a clean result");
  });

  it("does not scan a skills folder inside the current project", () => {
    rmSync(join(f().home, ".kit"), { recursive: true, force: true });
    writeFileSync(
      join(f().bin, "npm"),
      `#!/bin/sh\necho "$PWD" >> '${f().calls}'\ncase "$1" in\n  audit) echo '${AUDIT}'; exit 1;;\n  outdated) echo '{}'; exit 0;;\nesac\nexit 0\n`,
    );
    const project = join(f().home, "project");
    const scripts = join(project, ".claude", "skills", "projskill", "scripts");
    mkdirSync(join(scripts, "node_modules"), { recursive: true });
    writeFileSync(join(scripts, "package.json"), "{}");
    writeFileSync(join(scripts, "package-lock.json"), "{}");
    writeFileSync(f().calls, "");
    const r = spawnSync(process.execPath, [CLI, "hooks", "context"], {
      cwd: project,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: f().home,
        USERPROFILE: f().home,
        PATH: f().bin + delimiter + (process.env.PATH ?? ""),
      },
    });
    assert.equal(r.status, 0);
    assert.doesNotMatch(readFileSync(f().calls, "utf8"), /projskill/);
  });
});
