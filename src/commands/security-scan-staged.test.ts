import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { createCliContractFixture } from "../cli-contract.test-support.js";

function makeRepo(t: TestContext, config: string) {
  const fixture = createCliContractFixture(config);
  t.after(fixture.cleanup);
  const { cwd, env } = fixture;
  env.PATH = process.env.PATH;
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=t@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      {
        cwd,
        env,
        stdio: "pipe",
      },
    );
  git("init", "-q");
  git("add", ".kit.toml");
  git("commit", "-qm", "Fixture config");
  return { ...fixture, git };
}

it("reports staged line evidence and the reason for the exact finding marked", (t) => {
  const reason = "Synthetic sample for the scanner test";
  const { cwd, git, run } = makeRepo(
    t,
    `version = 1\n[[scan.allow]]\npath = "ci.js"\nmatch = "stripe-key"\nreason = "${reason}"\n`,
  );
  const marked = ["sk_", "test_", "M".repeat(24)].join("");
  const value = ["A7mK9qR2", "vX4yZ8bP", "5nW3dC6f"].join("");
  const sample = `const PASSWORD = "${value}";\n`;
  writeFileSync(join(cwd, "ci.js"), `// First line\n// ${marked}\n\n${sample}`);
  git("add", "ci.js");
  writeFileSync(join(cwd, "ci.js"), "// Working copy differs\n");
  const r = run(["security", "scan-staged", "--json"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal((r.stdout + r.stderr).includes(value), false);
  assert.equal((r.stdout + r.stderr).includes(marked), false);
  assert.deepEqual(JSON.parse(r.stdout), {
    ok: false,
    allowlistValid: true,
    findings: [{ file: "ci.js", line: 4, pattern: "keyed-secret", advisory: false }],
    gaps: [],
    marks: [{ file: "ci.js", line: 2, pattern: "stripe-key", reason }],
  });
});

it("reports an unreadable staged blob as a blocking gap", (t) => {
  const { cwd, git, run } = makeRepo(t, "version = 1\n");
  const file = "missing.env";
  writeFileSync(join(cwd, file), "fixture content");
  git("add", file);
  const hash = git("rev-parse", `:${file}`).toString().trim();
  assert.match(hash, /^[a-f0-9]{40,64}$/);
  unlinkSync(join(cwd, ".git", "objects", hash.slice(0, 2), hash.slice(2)));

  const r = run(["security", "scan-staged", "--json"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    ok: false,
    allowlistValid: true,
    findings: [],
    gaps: [{ file, detail: "unscannable staged blob (fail-closed)" }],
    marks: [],
  });
});
