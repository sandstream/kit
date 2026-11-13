/** Public gate checks for rejected source identities and credential privacy. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { decideBashGate, parseInstallCommand } from "./install-gate.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateDeps } from "./triage-gate.js";

it("classifies rejected query sources before masking their private data", async () => {
  for (const host of ["foreign.example", "github.com"]) {
    for (const suffix of [
      "?access_token=fixture-secret",
      "?access%5Ftoken=fixture%2Dsecret",
      "?ref=main&api_key=fixture-secret#fixture-fragment",
      "#access_token=fixture-secret",
    ]) {
      for (const installer of ["npx skills add", "claude plugin marketplace add"]) {
        const command = `${installer} 'https://${host}/owner/repo${suffix}'`;
        const parsed = parseInstallCommand(command);
        assert.ok(!parsed.refs.some((ref) => ref.startsWith("github:")));
        assert.equal(parsed.unverifiable.length, 1);
        assert.ok(
          parsed.unverifiable[0].endsWith(`https://${host}/owner/repo${suffix[0]}[redacted]`),
        );
        assert.doesNotMatch(JSON.stringify(parsed), /fixture/);
        const verdict = await decideBashGate(command, {
          runTriage: async () => assert.fail("query sources must be refused before triage"),
        });
        assert.equal(verdict.block, true);
        assert.deepEqual(verdict.checked, []);
        assert.ok(verdict.reason.includes(`https://${host}/owner/repo`));
        assert.doesNotMatch(verdict.reason, /fixture/);
      }
    }
  }
});

const probe = (command: string) => {
  const p = parseInstallCommand(command);
  return { isInstall: p.isInstall, refs: p.refs, unverifiable: p.unverifiable };
};

it("redacts userinfo even when a rejected source has malformed slashes", async () => {
  for (const source of [
    "https:///fixture-user:fixture-password@foreign.example/owner/repo",
    "https:/fixture-user:fixture-password@foreign.example/owner/repo",
    "https://fixture-user:fixture-password%40foreign.example/owner/repo",
    "ssh://fixture-user:fixture-password@foreign.example/owner/repo",
  ]) {
    const command = `npx skills add '${source}'`;
    const verdict = await decideBashGate(command, {
      runTriage: async () => assert.fail("a rejected source must not reach triage"),
    });
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /\[redacted\]@foreign\.example\/owner\/repo/);
    assert.doesNotMatch(verdict.reason, /fixture/);
    assert.doesNotMatch(JSON.stringify(probe(command)), /fixture/);
  }
});

it("refuses credential-bearing sources without exposing userinfo", async () => {
  for (const source of [
    "https://fixture-user:fixture-password@foreign.example/owner/repo",
    "https://fixture%2Duser:fixture%2Dpassword@foreign.example/owner/repo",
    "https://fixture-token@foreign.example/owner/repo",
    "https://fixture-user:fixture-password@github.com@foreign.example/owner/repo",
  ]) {
    for (const installer of ["npx skills add", "claude plugin marketplace add"]) {
      const command = `${installer} '${source}'`;
      const parsed = probe(command);
      const verdict = await decideBashGate(command, {
        runTriage: async () =>
          assert.fail("credential-bearing foreign sources cannot use GitHub triage"),
      });
      assert.equal(verdict.block, true);
      assert.ok(!parsed.refs.some((ref) => ref.startsWith("github:")));
      assert.match(verdict.reason, /https:\/\/\[redacted\]@foreign\.example\/owner\/repo/);
      assert.doesNotMatch(verdict.reason, /fixture/);
      assert.doesNotMatch(JSON.stringify(parsed), /fixture/);
    }
  }
});

for (const subpath of [
  "%2e",
  ".%2e",
  "%2E.",
  "%252e%252e",
  "%2e%2e%2felsewhere",
  "%2f%2fforeign.example",
  "%5c..",
  "%00",
  "%0d",
  "%0a",
  "%7f",
  "%C2%85",
  "%ZZ",
  "%",
  "%C0%AF",
]) {
  it(`refuses the ambiguous or invalid subpath ${subpath}`, async () => {
    const source = `https://github.com/owner/repo/tree/main/skills/${subpath}`;
    const command = `npx skills add '${source}'`;
    const verdict = await decideBashGate(command, {
      runTriage: async () => assert.fail("an ambiguous subpath must not reach triage"),
    });
    assert.equal(verdict.block, true, command);
    assert.deepEqual(probe(command).refs, ["npm:skills"]);
    assert.deepEqual(probe(command).unverifiable, [`repo-source:${source}`]);
  });
}

it("still refuses a foreign source when the skills runner is local", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kit-git-source-identity-"));
  try {
    mkdirSync(join(cwd, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(cwd, "node_modules", ".bin", "skills"), "");
    const deps: GateDeps = {
      runTriage: async () => assert.fail("a local runner cannot authorize a foreign source"),
    };
    const foreign = await decideBashGate(
      "npx skills add https://other.example/owner/repo",
      deps,
      cwd,
    );
    assert.equal(foreign.block, true);
    assert.match(foreign.reason, /other\.example/);
    const local = await decideBashGate("npx skills add ./local/repo", deps, cwd);
    assert.equal(local.block, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

it("does not let an earlier GitHub source hide a later foreign source", async () => {
  const command = "npx skills add owner/repo https://other.example/owner/repo";
  const verdict = await decideBashGate(command, {
    runTriage: async (type, target) => ({ type, target, passed: true, output: "TRIAGE PASSED" }),
  });
  assert.equal(verdict.block, true);
  assert.deepEqual(probe(command), {
    isInstall: true,
    refs: ["npm:skills", "github:owner/repo"],
    unverifiable: ["repo-source:https://other.example/owner/repo"],
  });
  assert.deepEqual(verdict.checked, []);
});

it("does not approve a foreign HTTPS source with the same GitHub owner/repo", async () => {
  const checked: string[] = [];
  const deps: GateDeps = {
    runTriage: async (type, target) => {
      checked.push(`${type}:${target}`);
      return { type, target, passed: true, output: "TRIAGE PASSED" };
    },
  };
  const github = await decideBashGate("npx skills add https://github.com/owner/repo", deps);
  assert.equal(github.block, false);
  assert.deepEqual(checked, ["npm:skills", "repo:https://github.com/owner/repo"]);
  checked.length = 0;

  const command = "npx skills add https://other.example/owner/repo";
  const foreign = await decideBashGate(command, deps);
  assert.equal(foreign.block, true, "GitHub metadata cannot approve another host");
  assert.deepEqual(checked, [], "unsupported sources must be refused before external triage");
  assert.deepEqual(probe(command), {
    isInstall: true,
    refs: ["npm:skills"],
    unverifiable: ["repo-source:https://other.example/owner/repo"],
  });
  assert.match(foreign.reason, /unsupported repository source/);
  assert.match(foreign.reason, /https:\/\/other\.example\/owner\/repo/);
});

for (const entry of [
  ["git@other.example:owner/repo.git", "[redacted]@other.example:owner/repo.git"],
  ["ssh://git@other.example/owner/repo.git", "ssh://[redacted]@other.example/owner/repo.git"],
  "git://other.example/owner/repo.git",
  [
    "git+ssh://git@other.example/owner/repo.git",
    "git+ssh://[redacted]@other.example/owner/repo.git",
  ],
  "git+https://other.example/owner/repo.git",
  "other.example/owner/repo",
  "https://localhost/owner/repo",
  ["ssh://git@localhost/owner/repo.git", "ssh://[redacted]@localhost/owner/repo.git"],
  ["ssh://git@internal/owner/repo.git", "ssh://[redacted]@internal/owner/repo.git"],
  "https://127.0.0.1/owner/repo",
  "https://[::1]/owner/repo",
  "https://github.com.other.example/owner/repo",
  ["https://github.com@other.example/owner/repo", "https://[redacted]@other.example/owner/repo"],
  ["https://other.example@github.com/owner/repo", "https://[redacted]@github.com/owner/repo"],
  ["ssh://github.com@internal/owner/repo.git", "ssh://[redacted]@internal/owner/repo.git"],
  "https://github.com:8443/owner/repo",
  ["git@github.com:443/owner/repo.git", "[redacted]@github.com:443/owner/repo.git"],
  "https://github.com./owner/repo",
  "https://%67ithub.com/owner/repo",
  "https://github%2ecom/owner/repo",
  ["https://github.com%40other.example/owner/repo", "https://[redacted]@other.example/owner/repo"],
  "https://github。com/owner/repo",
  "https:///github.com/owner/repo",
  "https:github.com/owner/repo",
  "//other.example/owner/repo",
  "https://github.com//owner/repo",
  "https://github.com/owner/repo/../../elsewhere/repo",
  "https://github.com/owner/repo/%2e%2e/%2e%2e/elsewhere/repo",
  "https://github.com/owner/repo%2felsewhere",
  [
    "https://github.com/owner/repo?source=other.example",
    "https://github.com/owner/repo?[redacted]",
  ],
  ["https://github.com\\@other.example/owner/repo", "https://[redacted]@other.example/owner/repo"],
  "https://github.com\r/owner/repo",
  "https://github.com/owner/repo\r",
  "ftp://github.com/owner/repo",
]) {
  const [source, display] = typeof entry === "string" ? [entry, entry] : entry;
  it(`refuses unsupported source ${JSON.stringify(source)} before any triage`, async () => {
    const checked: string[] = [];
    const deps: GateDeps = {
      runTriage: async (type, target) => {
        checked.push(`${type}:${target}`);
        return { type, target, passed: true, output: "TRIAGE PASSED" };
      },
    };
    for (const installer of [
      "npx skills add",
      "claude plugin marketplace add",
      "claude plugin install example --marketplace",
    ]) {
      const command = `${installer} '${source}'`;
      const parsed = probe(command);
      assert.equal(parsed.isInstall, true, command);
      assert.ok(
        parsed.unverifiable.some((ref) => ref.endsWith(display)),
        command,
      );
      assert.ok(!parsed.refs.some((ref) => ref.startsWith("github:")), command);
      const verdict = await decideBashGate(command, deps);
      assert.equal(verdict.block, true, command);
      assert.deepEqual(checked, [], command);
      assert.ok(verdict.reason.includes(display), command);
    }
  });
}
