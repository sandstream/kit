import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { createCliContractFixture } from "../cli-contract.test-support.js";

for (const [body, status, text] of [
  ['{"revoked":false}', 0, "active"],
  ['{"revoked":true}', 1, "revoked"],
  ['{"revoked":"false"}', 1, "unverified"],
  ["{broken", 1, "unverified"],
] as const) {
  it(`governance distinguishes revocation response ${body}`, (t) => {
    const endpoint = `data:application/json,${encodeURIComponent(body)}`;
    const fixture = createCliContractFixture(`version = 1
[governance]
enabled = true
[governance.agent]
id = "synthetic"
[governance.revocation]
enabled = true
revocation_endpoint = "${endpoint}"
`);
    t.after(() => fixture.cleanup());
    const before = fixture.snapshot();
    const result = fixture.run(["governance"]);
    assert.equal(result.status, status, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`Revocation status: ${text}`, "i"));
    assert.deepEqual(fixture.snapshot(), before);
  });
}

it("governance reports both zero budget limits without changing project or home", (t) => {
  const fixture = createCliContractFixture(`version = 1
[governance]
enabled = true
[governance.agent]
max_tokens_per_day = 0
max_operations_per_hour = 0
`);
  t.after(() => fixture.cleanup());
  const before = fixture.snapshot();
  const result = fixture.run(["governance"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Tokens: 0\/0 \(limit is zero\)/);
  assert.match(result.stdout, /Operations: 0\/0 \(limit is zero\)/);
  assert.deepEqual(fixture.snapshot(), before);
});

it("governance reports current usage and resets expired periods without persisting them", (t) => {
  const fixture = createCliContractFixture("version = 1\n[governance]\nenabled = true\n");
  t.after(() => fixture.cleanup());
  for (const expired of [false, true]) {
    const stamp = expired ? "2000-01-01T00:00:00.000Z" : new Date().toISOString();
    writeFileSync(
      join(fixture.cwd, ".kit-budget.json"),
      JSON.stringify({
        tokens_today: 27,
        operations_this_hour: 3,
        last_token_reset: stamp,
        last_operation_reset: stamp,
      }),
    );
    const before = fixture.snapshot();
    const result = fixture.run(["governance"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, expired ? /Tokens: 0\// : /Tokens: 27\//);
    assert.match(result.stdout, expired ? /Operations: 0\// : /Operations: 3\//);
    assert.deepEqual(fixture.snapshot(), before);
  }
});

it("governance handles missing configuration and a missing agent explicitly", (t) => {
  const fixture = createCliContractFixture();
  t.after(() => fixture.cleanup());
  fixture.env.NODE_ENV = "production";
  fixture.env.KIT_ENV = "review\x1b[2J\nghp_abcdefghijklmnopqrstuvwxyz0123456789";
  const before = fixture.snapshot();
  const result = fixture.run(["governance"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /No agent configured/);
  assert.match(result.stdout, /Access env: prod \(via env\)/);
  assert.doesNotMatch(result.stdout, /\x1b\[2J|ghp_abcdefghijklmnopqrstuvwxyz0123456789/);
  assert.deepEqual(fixture.snapshot(), before);
  unlinkSync(join(fixture.cwd, ".kit.toml"));
  const missing = fixture.snapshot();
  const failure = fixture.run(["governance"]);
  assert.equal(failure.status, 1, failure.stdout + failure.stderr);
  assert.equal(failure.stdout, "");
  assert.match(failure.stderr, /configuration/i);
  assert.deepEqual(fixture.snapshot(), missing);
});

async function runHttpFixture(fixture: ReturnType<typeof createCliContractFixture>) {
  const source = import.meta.url.endsWith(".ts");
  const cli = fileURLToPath(new URL(source ? "../cli.ts" : "../cli.js", import.meta.url));
  const loader = source ? ["--import", import.meta.resolve("tsx")] : [];
  const child = spawn(process.execPath, [...loader, cli, "governance"], {
    cwd: fixture.cwd,
    env: fixture.env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (data) => {
    output += data;
  });
  child.stderr.setEncoding("utf8").on("data", (data) => {
    output += data;
  });
  try {
    const [status, signal] = await once(child, "close");
    assert.equal(signal, null, output);
    return { status, output };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

it("governance uses bounded HTTP GET checks and keeps errors distinct from revoked status", async (t) => {
  const requests: { method: string | undefined; url: string | undefined }[] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    if (req.url?.startsWith("/hang/")) return;
    if (req.url?.startsWith("/disconnect/")) {
      req.socket.destroy();
      return;
    }
    if (req.url?.startsWith("/error/")) {
      res.writeHead(503, "ghp_abcdefghijklmnopqrstuvwxyz0123456789");
      res.end("private-response-marker");
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ revoked: req.url?.startsWith("/revoked/") ?? false }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  for (const mode of ["active", "revoked", "error", "disconnect", "hang", "disabled"]) {
    await t.test(mode, async () => {
      const fixture = createCliContractFixture(`version = 1
[governance]
enabled = ${mode !== "disabled"}
[governance.agent]
id = "agent/with?query#fragment"
[governance.revocation]
enabled = true
revocation_endpoint = "http://127.0.0.1:${address.port}/${mode}/{agent_id}"
`);
      try {
        const before = fixture.snapshot();
        const previousRequests = requests.length;
        const result = await runHttpFixture(fixture);
        const ok = mode === "active" || mode === "disabled";
        assert.equal(result.status, ok ? 0 : 1, result.output);
        const expected =
          mode === "disabled"
            ? "not checked"
            : ["active", "revoked"].includes(mode)
              ? mode
              : "unverified";
        assert.match(result.output, new RegExp(`Revocation status: ${expected}`));
        assert.doesNotMatch(
          result.output,
          /ghp_abcdefghijklmnopqrstuvwxyz0123456789|private-response-marker/,
        );
        assert.equal(requests.length - previousRequests, mode === "disabled" ? 0 : 1);
        if (mode !== "disabled")
          assert.deepEqual(requests.at(-1), {
            method: "GET",
            url: `/${mode}/agent%2Fwith%3Fquery%23fragment`,
          });
        assert.deepEqual(fixture.snapshot(), before);
      } finally {
        fixture.cleanup();
      }
    });
  }
});

it("governance reports the selected overlay separately from its access environment", (t) => {
  const fixture = createCliContractFixture(`version = 1
[governance]
enabled = true
environment = "dev"
[env.staging.governance]
enabled = true
environment = "prod"
[env.staging.governance.agent]
name = "review-agent"
max_tokens_per_day = 60
max_operations_per_hour = 4
`);
  t.after(() => fixture.cleanup());
  fixture.env.KIT_READ_ONLY = "1";
  const before = fixture.snapshot();
  const result = fixture.run(["--env", "staging", "governance"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Config env: staging/);
  assert.match(result.stdout, /Access env: prod \(via config\)/);
  assert.match(result.stdout, /Permissions: read\n/);
  assert.match(result.stdout, /Read-only mode: active/);
  assert.match(result.stdout, /Name: review-agent/);
  assert.match(result.stdout, /Tokens: 0\/60/);
  assert.match(result.stdout, /Operations: 0\/4/);
  assert.deepEqual(fixture.snapshot(), before);
});

it("disabled governance labels unenforced budgets and skips the revocation endpoint", (t) => {
  const fixture = createCliContractFixture(`version = 1
[governance]
enabled = false
[governance.agent]
id = "synthetic"
[governance.revocation]
enabled = true
revocation_endpoint = "data:application/json,%7B%22revoked%22%3Atrue%7D"
`);
  t.after(() => fixture.cleanup());
  const before = fixture.snapshot();
  const result = fixture.run(["governance"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Governance: disabled/);
  assert.match(result.stdout, /Budget enforcement: disabled/);
  assert.match(result.stdout, /Revocation status: not checked \(governance disabled\)/);
  assert.doesNotMatch(result.stdout, /Revocation status: (active|revoked)/i);
  assert.deepEqual(fixture.snapshot(), before);
});

it("governance reports configuration and budget errors without source text or partial status", async (t) => {
  for (const invalid of ["config", "budget"]) {
    await t.test(invalid, () => {
      const fixture = createCliContractFixture("version = 1\n[governance]\nenabled = true\n");
      t.after(() => fixture.cleanup());
      const file = invalid === "config" ? ".kit.toml" : ".kit-budget.json";
      writeFileSync(join(fixture.cwd, file), 'name = "ghp_abcdefghijklmnopqrstuvwxyz0123456789');
      const before = fixture.snapshot();
      const result = fixture.run(["governance"]);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, invalid === "config" ? /configuration/i : /budget/i);
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /ghp_abcdefghijklmnopqrstuvwxyz0123456789/,
      );
      assert.deepEqual(fixture.snapshot(), before);
    });
  }
});

it("governance fails an unverified revocation check without claiming confirmed revocation", (t) => {
  const fixture = createCliContractFixture(`version = 1
[governance]
enabled = true
[governance.revocation]
enabled = true
`);
  t.after(() => fixture.cleanup());
  const before = fixture.snapshot();
  const result = fixture.run(["governance"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Revocation status: unverified/i);
  assert.match(result.stderr, /revocation_endpoint.*agent.id/i);
  assert.doesNotMatch(result.stdout, /REVOKED|Active/);
  assert.deepEqual(fixture.snapshot(), before);
});

it("governance sanitizes agent names and IDs before terminal output", (t) => {
  const fixture = createCliContractFixture(`version = 1
[governance]
enabled = true
[governance.agent]
name = "agent\\u001b[2J\\nPermissions: all\\u202e"
id = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"
`);
  t.after(() => fixture.cleanup());
  const before = fixture.snapshot();
  const result = fixture.run(["governance"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /\u001b\[2J|\u202e|ghp_abcdefghijklmnopqrstuvwxyz0123456789/);
  const visible = stripVTControlCharacters(result.stdout);
  assert.match(visible, /^Name: agentPermissions: all$/m);
  assert.match(visible, /^ID: \[REDACTED\]$/m);
  assert.doesNotMatch(visible, /^Permissions: all$/m);
  assert.deepEqual(fixture.snapshot(), before);
});

it("governance refuses path-changing identities but accepts literal query values without local writes", async (t) => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    res.end('{"revoked":false}');
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  for (const path of ["/agents/{agent_id}/status", "/status?agent={agent_id}"]) {
    const fixture = createCliContractFixture(`version = 1
[governance]
enabled = true
[governance.agent]
id = ".."
[governance.revocation]
enabled = true
revocation_endpoint = "http://127.0.0.1:${address.port}${path}"
`);
    try {
      const before = fixture.snapshot();
      const result = await runHttpFixture(fixture);
      const refused = path.startsWith("/agents/");
      assert.equal(result.status, refused ? 1 : 0, result.output);
      assert.match(
        result.output,
        refused ? /Revocation status: unverified/ : /Revocation status: active/,
      );
      if (refused)
        assert.match(result.output, /Agent identity changes the revocation endpoint path/);
      assert.deepEqual(requests, refused ? [] : ["/status?agent=.."]);
      assert.deepEqual(fixture.snapshot(), before);
    } finally {
      fixture.cleanup();
    }
  }
});
