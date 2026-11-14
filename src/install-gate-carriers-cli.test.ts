import assert from "node:assert/strict";
import { it } from "node:test";
import { createCliContractFixture } from "./cli-contract.test-support.js";

for (const command of [
  'env -S "npm i gate-fixture"',
  'env -vu sh -S "npm i gate-fixture"',
  'env \\-S "npm i gate-fixture"',
  'env -u FOO \\\nenv -S "npm i gate-fixture"',
  'sudo -p "Enter password: " env -S "npm i gate-fixture"',
  'sudo -p "" env -S "npm i gate-fixture"',
  'sudo -p "Prompt; # text" env -S "npm i gate-fixture"',
  'echo ready # don\'t change this\nenv -S "npm i gate-fixture"',
  'echo ready # a "quoted note\nenv -S "npm i gate-fixture"',
  "uv --config-file=/tmp/config add gate-fixture",
  "uv --config-file /tmp/config tool run gate-fixture",
  "uv --config-file /tmp/config run --with gate-fixture script.py",
  'pipx --pip-args "--trusted-host packages.example" run gate-fixture',
  "uv run --group dev --config-file=/tmp/config --with gate-fixture python script.py",
  "uvx --cache-dir /tmp --config-file=/tmp/config gate-fixture",
  "pdm -vc/tmp/config add gate-fixture",
]) {
  it(`Claude and Codex hooks deny the unresolved command: ${command}`, (t) => {
    const fixture = createCliContractFixture();
    t.after(() => fixture.cleanup());
    const result = fixture.run(
      ["gate-bash"],
      JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    );
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /install-gate: BLOCKED/);
    assert.match(result.stderr, /split-string|source-configuration|UNVERIFIED SOURCE/);
    assert.match(result.stderr, /Use explicit command arguments|Remove the source configuration/);
    assert.doesNotMatch(result.stderr, /Triage it first|run `kit triage` manually/);
  });

  it(`Cursor hooks deny the unresolved command: ${command}`, (t) => {
    const fixture = createCliContractFixture();
    t.after(() => fixture.cleanup());
    const result = fixture.run(["gate-bash"], JSON.stringify({ command }));
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /install-gate: BLOCKED/);
  });

  it(`Cline hooks cancel the unresolved command: ${command}`, (t) => {
    const fixture = createCliContractFixture();
    t.after(() => fixture.cleanup());
    const result = fixture.run(
      ["gate-bash", "--format", "cline"],
      JSON.stringify({ preToolUse: { toolName: "Bash", parameters: { command } } }),
    );
    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout);
    assert.equal(response.cancel, true);
    assert.match(response.errorMessage, /split-string|source-configuration|UNVERIFIED SOURCE/);
    assert.match(
      response.errorMessage,
      /Use explicit command arguments|Remove the source configuration/,
    );
    assert.doesNotMatch(response.errorMessage, /Triage it first|run `kit triage` manually/);
  });
}

for (const command of [
  "git status",
  "env git show -Sneedle",
  "env echo -S hello",
  "uv run -- python app.py --config-file=settings.toml",
  "uv run python app.py --config-file=settings.toml",
])
  it(`the hook allows command arguments: ${command}`, (t) => {
    const fixture = createCliContractFixture();
    t.after(() => fixture.cleanup());
    const result = fixture.run(
      ["gate-bash"],
      JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    // Node can report its experimental SQLite API; that warning is not a hook denial.
    assert.doesNotMatch(result.stderr, /install-gate: BLOCKED/);
  });
