/** Compiled gate-bash CLI contracts with only external triage replaced. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { repositoryGateFixture } from "./install-gate-repos-cli.test-support.js";

const gate = repositoryGateFixture();

it("preserves known global option arities through the compiled CLI", () => {
  for (const runner of [
    "npm --loglevel=error exec",
    "npm --loglevel error exec",
    "npm exec --loglevel=error",
    "npx --loglevel error",
    "npm --location=project exec",
    "npm --location project exec",
    "npm -L project exec",
    "npm -C ./project exec",
  ]) {
    const github = gate(`${runner} --package=skills -- skills add owner/repo`);
    assert.equal(github.status, 0, github.stderr);
    assert.match(github.stderr, /FIXTURE_TRIAGE npm:skills/);
    assert.match(github.stderr, /FIXTURE_TRIAGE repo:https:\/\/github\.com\/owner\/repo/);
    const foreign = gate(
      `${runner} --package=skills -- skills add https://foreign.example/owner/repo`,
    );
    assert.equal(foreign.status, 2, foreign.stderr);
    assert.match(foreign.stderr, /unsupported repository source/);
    assert.doesNotMatch(foreign.stderr, /FIXTURE_TRIAGE/);
  }
});

it("masks query credentials before stderr and Cline refusal output", () => {
  for (const source of [
    "https://foreign.example/owner/repo?access_token=fixture-secret",
    "https://github.com/owner/repo?access%5Ftoken=fixture%2Dsecret",
    "https://foreign.example/owner/repo?unlisted_key=fixture-secret",
    "https://foreign.example/owner/repo#fixture-fragment",
    "https://fixture-user:fixture-password@foreign.example/owner/repo?api_key=fixture-secret",
  ]) {
    for (const installer of ["npx skills add", "claude plugin marketplace add"]) {
      for (const format of [undefined, "cline"] as const) {
        const result = gate(`${installer} '${source}'`, format);
        assert.equal(result.status, format ? 0 : 2, result.stderr);
        const output = result.stdout + result.stderr;
        assert.doesNotMatch(output, /fixture/);
        assert.match(output, /(?:foreign\.example|github\.com)\/owner\/repo[?#]\[redacted\]/);
        assert.doesNotMatch(output, /FIXTURE_TRIAGE/);
        if (format) assert.equal(JSON.parse(result.stdout).cancel, true);
      }
    }
  }
});

it("checks executable basenames through the compiled CLI", () => {
  for (const executable of ["./node_modules/.bin/skills", "/opt/tools/skills", "tools/skills"]) {
    const foreign = gate(
      `npm exec --package=skills -- ${executable} add https://foreign.example/owner/repo`,
    );
    assert.equal(foreign.status, 2, foreign.stderr);
    assert.match(foreign.stderr, /unsupported repository source/);
    assert.doesNotMatch(foreign.stderr, /FIXTURE_TRIAGE/);
    const github = gate(`npm exec --package=other -- ${executable} add owner/repo`);
    assert.equal(github.status, 0, github.stderr);
    assert.match(github.stderr, /FIXTURE_TRIAGE npm:other/);
    assert.match(github.stderr, /FIXTURE_TRIAGE repo:https:\/\/github\.com\/owner\/repo/);
    assert.doesNotMatch(github.stderr, /FIXTURE_TRIAGE npm:skills/);
    const local = gate(`npm exec --package=skills -- ${executable} add ./local/repo`);
    assert.equal(local.status, 0, local.stderr);
    assert.doesNotMatch(local.stderr, /FIXTURE_TRIAGE repo:/);
  }
  for (const executable of ["./skills/other", "/opt/skills-helper", "./node_modules/.bin/other"]) {
    const result = gate(
      `npm exec --package=skills -- ${executable} add https://foreign.example/owner/repo`,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /FIXTURE_TRIAGE npm:skills/);
    assert.doesNotMatch(result.stderr, /FIXTURE_TRIAGE repo:/);
  }
});

it("refuses unresolved npm runner calls through the compiled CLI", () => {
  for (const prefix of [
    "npm exec --package=skills --call",
    "npm exec --package=skills --call=",
    "npm exec --package=skills -c",
    "npx --package=skills --call",
  ]) {
    const result = gate(
      `${prefix}${prefix.endsWith("=") ? "" : " "}'skills add https://foreign.example/owner/repo'`,
    );
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /runner-command:/);
    assert.doesNotMatch(result.stderr, /FIXTURE_TRIAGE/);
  }
  const unresolved = gate("npm exec --package=skills --call 'echo fixture'");
  assert.equal(unresolved.status, 2, unresolved.stderr);
  assert.doesNotMatch(unresolved.stderr, /FIXTURE_TRIAGE/);
  const child = gate("npm exec --package=skills -- other --call fixture");
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stderr, /FIXTURE_TRIAGE npm:skills/);
});

it("redacts rejected source credentials before CLI output", () => {
  const source = "https://fixture-user:fixture-password@foreign.example/owner/repo";
  for (const installer of ["npx skills add", "claude plugin marketplace add"]) {
    for (const format of [undefined, "cline"] as const) {
      const result = gate(`${installer} '${source}'`, format);
      assert.equal(result.status, format ? 0 : 2);
      const output = result.stdout + result.stderr;
      assert.doesNotMatch(output, /fixture-user|fixture-password/);
      assert.match(output, /https:\/\/\[redacted\]@foreign\.example\/owner\/repo/);
      assert.doesNotMatch(output, /FIXTURE_TRIAGE/);
      if (format) assert.equal(JSON.parse(result.stdout).cancel, true);
    }
  }
});

for (const [child, blocked] of [
  ["env skills", true],
  ["/usr/bin/env skills", true],
  ["env -i FLAG=1 skills", true],
  ["env -u UNUSED skills", true],
  ["env --unset=UNUSED FLAG=1 skills", true],
  ["env -- env FLAG=1 skills", true],
  ["env other skills", false],
  ["env FLAG=skills other", false],
  ["env -u skills other", false],
  ["env -- other", false],
] as const) {
  it(`enforces the actual env child through the CLI: ${child}`, () => {
    const result = gate(
      `npm exec --package=skills -- ${child} add https://foreign.example/owner/repo`,
    );
    assert.equal(result.status, blocked ? 2 : 0, result.stderr);
    if (blocked) {
      assert.match(result.stderr, /unsupported repository source/);
      assert.doesNotMatch(result.stderr, /FIXTURE_TRIAGE/);
    } else {
      assert.match(result.stderr, /FIXTURE_TRIAGE npm:skills/);
      assert.doesNotMatch(result.stderr, /FIXTURE_TRIAGE repo:/);
    }
  });
}

for (const [prefix, packageName, blocked] of [
  ["npm exec -p skills --", "skills", true],
  ["npm exec -p=false skills --", "skills", true],
  ["npm --cache ./cache exec -p skills --", "skills", true],
  ["npm --cache install exec --package=skills -- env skills", "skills", true],
  ["npx -p=skills -- skills", "skills", true],
  ["npm exec --parseable skills --", "skills", true],
  ["npm -p exec skills --", "skills", true],
  ["npm exec -p other --", "other", false],
  ["npx -p skills -- other", "skills", false],
  ["npx -p skills -- skills", "skills", true],
  ["npx --package=skills -- skills", "skills", true],
  ["npm exec --package=skills -- other", "skills", false],
  ["npx other --package=skills", "other", false],
  ["npm exec -- other --package=skills", "other", false],
  ["npm exec other --package=skills --", "skills", false],
  ["npm exec -p --package skills -- skills", "skills", true],
] as const) {
  it(`enforces manager-specific arguments through the CLI: ${prefix}`, () => {
    const result = gate(`${prefix} add https://foreign.example/owner/repo`);
    assert.equal(result.status, blocked ? 2 : 0, result.stderr);
    if (blocked) {
      assert.match(result.stderr, /unsupported repository source/);
      assert.doesNotMatch(result.stderr, /FIXTURE_TRIAGE/);
    } else {
      assert.ok(result.stderr.includes(`FIXTURE_TRIAGE npm:${packageName}\n`), result.stderr);
      assert.doesNotMatch(result.stderr, /FIXTURE_TRIAGE repo:/);
    }
  });
}

it("rejects the invoked skills command regardless of package order", () => {
  for (const [runner, packages] of [
    ["npm exec", "--package=other --package=skills"],
    ["npm exec", "--package=skills --package=other"],
    ["npx", "-p other -p skills"],
    ["npx", "-p skills -p other"],
  ]) {
    const result = gate(`${runner} ${packages} -- skills add https://foreign.example/owner/repo`);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /unsupported repository source/);
    assert.match(result.stderr, /https:\/\/foreign\.example\/owner\/repo/);
    assert.doesNotMatch(result.stderr, /FIXTURE_TRIAGE/);
  }
});

it("allows the other command when skills is only an available package", () => {
  for (const [runner, packages] of [
    ["npm exec", "--package=skills --package=other"],
    ["npm exec", "--package=other --package=skills"],
    ["npx", "-p skills -p other"],
    ["npx", "-p other -p skills"],
  ]) {
    const result = gate(`${runner} ${packages} -- other add https://foreign.example/owner/repo`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /FIXTURE_TRIAGE npm:other/);
    assert.match(result.stderr, /FIXTURE_TRIAGE npm:skills/);
    assert.doesNotMatch(result.stderr, /FIXTURE_TRIAGE repo:/);
  }
});

it("accepts a .json repository name through skills", () => {
  for (const source of ["owner/schema.json", "https://github.com/owner/schema.json"]) {
    const result = gate(`npx skills add ${source}`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /FIXTURE_TRIAGE repo:https:\/\/github\.com\/owner\/schema\.json/);
  }
});

it("accepts safe GitHub subpaths without changing the triaged repository", () => {
  for (const path of ["@scope", "c%2B%2B"]) {
    const result = gate(`npx skills add https://github.com/owner/repo/tree/main/skills/${path}`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /FIXTURE_TRIAGE repo:https:\/\/github\.com\/owner\/repo\n/);
  }
  for (const path of ["%2e%2e/elsewhere", "%0a"]) {
    const result = gate(`npx skills add https://github.com/owner/repo/tree/main/skills/${path}`);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /unsupported repository source/);
    assert.doesNotMatch(result.stderr, /FIXTURE_TRIAGE/);
  }
});

it("refuses foreign HTTPS, SSH and Git sources without external triage", () => {
  for (const entry of [
    "https://other.example/owner/repo",
    ["git@other.example:owner/repo.git", "[redacted]@other.example:owner/repo.git"],
    ["ssh://git@internal/owner/repo.git", "ssh://[redacted]@internal/owner/repo.git"],
    "git://other.example/owner/repo.git",
    ["https://github.com@other.example/owner/repo", "https://[redacted]@other.example/owner/repo"],
    "https://%67ithub.com/owner/repo",
  ]) {
    const [source, display] = typeof entry === "string" ? [entry, entry] : entry;
    const result = gate(`npx skills add '${source}'`);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /unsupported repository source/);
    assert.ok(result.stderr.includes(display), result.stderr);
    assert.doesNotMatch(result.stderr, /FIXTURE_TRIAGE/);
  }
});

it("keeps the supported GitHub source and wrapper on the real triage path", () => {
  const result = gate("npx skills add https://github.com/owner/repo");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /FIXTURE_TRIAGE npm:skills/);
  assert.match(result.stderr, /FIXTURE_TRIAGE repo:https:\/\/github\.com\/owner\/repo/);
});

it("refuses an unsupported plugin marketplace and allows a local marketplace", () => {
  const foreign = gate("claude plugin marketplace add ssh://git@internal/owner/repo.git");
  assert.equal(foreign.status, 2, foreign.stderr);
  assert.match(foreign.stderr, /ssh:\/\/\[redacted\]@internal\/owner\/repo\.git/);
  assert.doesNotMatch(foreign.stderr, /FIXTURE_TRIAGE/);
  const local = gate("claude plugin marketplace add ./local/repo");
  assert.equal(local.status, 0, local.stderr);
  assert.doesNotMatch(local.stderr, /FIXTURE_TRIAGE/);
});

it("returns the Cline refusal contract for an unsupported source", () => {
  const result = gate("npx skills add https://other.example/owner/repo", "cline");
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.cancel, true);
  assert.match(payload.errorMessage, /unsupported repository source/);
  assert.match(payload.errorMessage, /other\.example/);
  assert.doesNotMatch(result.stderr, /FIXTURE_TRIAGE/);
});
