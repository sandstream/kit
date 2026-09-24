import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEnvGitignored } from "./check-security.js";
import { runHeal, safeRecipe, type HealDeps } from "./heal.js";

function fixture(
  t: TestContext,
  ignore: string,
): { dir: string; deps: HealDeps; attempts: () => number } {
  const dir = mkdtempSync(join(tmpdir(), "kit-heal-ignore-"));
  const previous = process.cwd();
  t.after(() => {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  });
  execFileSync("git", ["init", "-q", dir]);
  writeFileSync(join(dir, ".gitignore"), ignore);
  process.chdir(dir);
  let attempts = 0;
  return {
    dir,
    attempts: () => attempts,
    deps: {
      scan: async () => [await checkEnvGitignored(dir)],
      sync: async () => null,
      recipe: (finding) => {
        const repair = safeRecipe(finding);
        assert.ok(repair);
        return async () => {
          attempts++;
          await repair();
        };
      },
    },
  };
}

describe("heal retains unresolved Git protection findings", () => {
  it("returns tracked dotenv secrets for manual action after repair throws", async (t) => {
    const { dir, deps, attempts } = fixture(t, ".env*\n");
    writeFileSync(join(dir, ".env.keys"), "fixture only\n");
    execFileSync("git", ["add", "-f", "--", ".env.keys"], { cwd: dir });
    assert.equal((await checkEnvGitignored(dir)).status, "fail");

    const result = await runHeal({}, deps);
    assert.deepEqual(result.healed, []);
    assert.equal(attempts(), 1, "a failed repair must not be retried indefinitely");
    assert.equal(result.iterations, 2);
    assert.equal(readFileSync(join(dir, ".env.keys"), "utf8"), "fixture only\n");
    assert.equal(
      execFileSync("git", ["ls-files", "-z"], { cwd: dir, encoding: "utf8" }),
      ".env.keys\0",
    );
    assert.equal(result.gated.length, 1, "an unresolved safe finding must prevent a clean result");
    assert.equal(result.gated[0].name, ".env gitignored");
    assert.match(result.gated[0].issue, /already tracked/);
  });

  it("still reports a successful Git repair as healed", async (t) => {
    const { dir, deps, attempts } = fixture(t, ".env*\n!.env.keys\n");
    const result = await runHeal({}, deps);
    assert.deepEqual(result.healed, ["secrets:.env gitignored"]);
    assert.deepEqual(result.gated, []);
    assert.deepEqual(result.failClosed, []);
    assert.equal(attempts(), 1);
    execFileSync("git", ["check-ignore", "-q", "--", ".env.keys"], { cwd: dir });
  });
});
