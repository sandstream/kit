/** A repository source the shell would expand, or a shell child that runs one, is not verifiable. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseInstallCommand } from "./install-gate.js";
import { repoSourceArg } from "./install-gate-repos.js";

describe("repository sources the shell expands", () => {
  for (const source of [
    "$REPO",
    "${REPO}",
    "`echo x`",
    "$(echo x)",
    "{a,b}",
    "o*/r",
    "o?/r",
    "./$X",
  ]) {
    it(`${source} cannot be verified`, () => {
      const result = repoSourceArg(source);
      assert.ok(result && "unverifiable" in result);
    });
  }

  it("still reads a plain GitHub shorthand and a local path", () => {
    assert.deepEqual(repoSourceArg("owner/repo"), { ref: "github:owner/repo" });
    assert.equal(repoSourceArg("./local/repo"), null);
  });

  it("refuses `npx skills add $REPO`", () => {
    const parsed = parseInstallCommand("npx skills add $REPO");
    assert.equal(parsed.unverifiable.length, 1);
    assert.match(parsed.unverifiable[0], /^repo-source:/);
  });
});

describe("a shell as the runner child", () => {
  for (const runner of [
    "npx --package=skills --",
    "npx -p skills --",
    "pnpm dlx --package=skills",
    "bunx --package=skills",
  ]) {
    it(`refuses ${runner} sh -c`, () => {
      const parsed = parseInstallCommand(
        `${runner} sh -c "skills add https://foreign.example/o/r"`,
      );
      assert.equal(parsed.isInstall, true);
      assert.deepEqual(parsed.unverifiable, ["wrapper-command:sh -c"]);
    });
  }

  it("leaves a shell child alone when no repository installer is among the packages", () => {
    const parsed = parseInstallCommand('npx --package=left-pad -- sh -c "echo hi"');
    assert.deepEqual(parsed.unverifiable, []);
  });
});
