import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { readAuditLog } from "./audit.js";
import { createCliContractFixture } from "./cli-contract.test-support.js";
import {
  governanceClient,
  governanceFixture,
  projectConfig,
} from "./governance-outcome.test-support.js";

function denyNetwork(cwd: string, allow: string[] = []) {
  writeFileSync(
    join(cwd, ".kit-exec-broker.json"),
    JSON.stringify({ egress: { allow }, fs: { root: cwd }, env: { declared: [] } }),
  );
}
function markerScript(cwd: string) {
  const marker = join(cwd, "child-ran");
  const script = join(cwd, "marker.cjs");
  writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`);
  return { marker, script };
}

it("CLI masks raw secret arguments before audit JSON escaping", async (t) => {
  const fixture = createCliContractFixture(projectConfig);
  t.after(() => fixture.cleanup());
  const secret = 'fixture"token\\with\\escapes';
  writeFileSync(join(fixture.cwd, ".env.local"), `API_TOKEN='${secret}'\n`);
  denyNetwork(fixture.cwd);
  const result = fixture.run(["run", "--", process.execPath, "-e", "process.exit(0)", secret]);
  assert.equal(result.status, 0, result.stderr);
  const events = await readAuditLog(join(fixture.cwd, ".kit-audit.jsonl"));
  assert.equal(events.length, 3);
  for (const event of events) {
    const command = String(event.metadata?.command);
    assert.ok(command.includes("[REDACTED]"), "audit command must mask the raw secret");
    assert.ok(!command.includes(JSON.stringify(secret)), "escaped secrets remain recoverable");
  }
});

it("CLI checks schemaless curl targets before starting the child", (t) => {
  const fixture = createCliContractFixture();
  t.after(() => fixture.cleanup());
  denyNetwork(fixture.cwd);
  const result = fixture.run(["run", "--", "curl", "outside.invalid"]);
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /exec-broker.*denied/i,
    "PATH has no curl; denial must precede executable lookup",
  );
  assert.doesNotMatch(result.stderr, /ENOENT/);
});

for (const target of [
  "https://outside.invalid",
  "https:'//outside.invalid'",
  "'https'://outside.invalid",
  "https://[2001:db8::1]/",
  "https://allowed.invalid;@outside.invalid/",
]) {
  it(`MCP checks the parsed URL argument ${target}`, async (t) => {
    const { host, target: cwd } = governanceFixture(t);
    denyNetwork(cwd, ["allowed.invalid"]);
    const { marker, script } = markerScript(cwd);
    const client = await governanceClient(t);
    const result = await client.callTool({
      name: "kit_run",
      arguments: { cwd, command: `"${process.execPath}" "${script}" ${target}` },
    });
    assert.equal(
      existsSync(marker),
      false,
      "equivalent quoted URLs must be refused before execution",
    );
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /denied/i);
    assert.equal(existsSync(join(host, ".kit-audit.jsonl")), false);
  });
}

it("MCP applies target read-only policy without contaminating the server or later requests", async (t) => {
  const { host, target } = governanceFixture(t);
  writeFileSync(join(target, ".kit.toml"), 'version = 1\n[policy]\ndefault_mode = "read-only"\n');
  const { marker, script } = markerScript(target);
  const client = await governanceClient(t);
  const request = {
    name: "kit_run",
    arguments: { cwd: target, command: `"${process.execPath}" "${script}"` },
  };
  const denied = await client.callTool(request);
  assert.equal(existsSync(marker), false);
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied.content), /read-only/);
  const events = await readAuditLog(join(target, ".kit-audit.jsonl"));
  assert.ok(events.some((e) => !e.success && e.operation === "read-only-mode-refusal"));
  assert.equal(existsSync(join(host, ".kit-audit.jsonl")), false);
  assert.notEqual(process.env.KIT_READ_ONLY, "1");
  writeFileSync(join(target, ".kit.toml"), "version = 1\n");
  const allowed = await client.callTool(request);
  assert.notEqual(allowed.isError, true, JSON.stringify(allowed));
  assert.equal(readFileSync(marker, "utf8"), "started");
});

for (const contaminated of [false, true]) {
  it(`MCP permission checks use the target branch (Git environment contaminated=${contaminated})`, async (t) => {
    const { host, target } = governanceFixture(t);
    delete process.env.NODE_ENV;
    for (const [cwd, branch] of [
      [host, "feature/review"],
      [target, "main"],
    ]) {
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "--allow-empty",
          "-qm",
          "fixture",
        ],
        { cwd },
      );
      execFileSync("git", ["branch", "-M", branch], { cwd });
    }
    writeFileSync(join(target, ".kit.toml"), projectConfig.replace('environment = "dev"\n', ""));
    if (contaminated) process.env.GIT_DIR = join(host, ".git");
    const { marker, script } = markerScript(target);
    const client = await governanceClient(t);
    const result = await client.callTool({
      name: "kit_run",
      arguments: { cwd: target, command: `"${process.execPath}" "${script}"` },
    });
    assert.equal(existsSync(marker), false, "main uses production write restrictions");
    assert.equal(result.isError, true);
    const events = await readAuditLog(join(target, ".kit-audit.jsonl"));
    assert.equal(events.length, 1);
    assert.equal(events[0].environment, "prod");
    assert.equal(events[0].success, false);
    assert.equal(existsSync(join(host, ".kit-audit.jsonl")), false);
  });
}

it("MCP masks parsed secret arguments in both audit and response text", async (t) => {
  const { target } = governanceFixture(t);
  const secret = 'fixture"token\\with\\escapes';
  writeFileSync(join(target, ".env.local"), `API_TOKEN='${secret}'\n`);
  const script = join(target, "echo.cjs");
  writeFileSync(script, "process.stdout.write(process.argv[2])");
  const client = await governanceClient(t);
  const result = await client.callTool({
    name: "kit_run",
    arguments: {
      cwd: target,
      command: `"${process.execPath}" "${script}" ${JSON.stringify(secret)}`,
    },
  });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const response = (result.content as Array<{ text: string }>)[0].text;
  assert.match(response, /Command:.*REDACTED/);
  assert.ok(!response.includes(secret));
  assert.ok(!response.includes(JSON.stringify(secret)));
  const events = await readAuditLog(join(target, ".kit-audit.jsonl"));
  assert.equal(events.length, 1);
  assert.match(String(events[0].metadata?.command), /REDACTED/);
  assert.ok(!String(events[0].metadata?.command).includes(JSON.stringify(secret)));
});
