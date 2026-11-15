import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
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

describe("kit hooks context reports skill dependencies", { skip: !posix }, () => {
  let home: string;
  let bin: string;
  let calls: string;

  before(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "kit-hookctx-")));
    bin = join(home, "bin");
    calls = join(home, "npm-calls.log");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "npm"),
      `#!/bin/sh\necho "$1" >> '${calls}'\ncase "$1" in\n  audit) echo '${AUDIT}'; exit 1;;\n  outdated) echo '${OUTDATED}'; exit 1;;\nesac\nexit 0\n`,
    );
    chmodSync(join(bin, "npm"), 0o755);
    const scripts = join(home, ".claude", "skills", "tillganglighet", "scripts");
    mkdirSync(join(scripts, "node_modules"), { recursive: true });
    writeFileSync(join(scripts, "package.json"), '{"dependencies":{"axe-core":"4.10.3"}}');
    writeFileSync(join(scripts, "package-lock.json"), '{"lockfileVersion":3}');
  });
  after(() => rmSync(home, { recursive: true, force: true }));

  const run = (extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [CLI, "hooks", "context"], {
      cwd: home,
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
  const npmCalls = () => readFileSync(calls, "utf8").split("\n").filter(Boolean).length;

  it("prints one plain line naming the skill, the vulnerability and the major behind", () => {
    const r = run();
    assert.equal(r.status, 0);
    const lines = r.stdout.split("\n").filter((l) => l.startsWith("kit: skill"));
    assert.equal(lines.length, 1, r.stdout + r.stderr);
    assert.match(lines[0], /tillganglighet/);
    assert.match(lines[0], /1 known vulnerability \(1 high\) in axe-core/);
    assert.match(lines[0], /playwright 1\.58\.0 \(latest 2\.0\.0\)/);
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

  it("exits 0 and says nothing when npm is not usable", () => {
    rmSync(join(home, ".kit"), { recursive: true, force: true });
    writeFileSync(join(bin, "npm"), "#!/bin/sh\nexit 127\n");
    const r = run();
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /kit: skill/);
  });
});
