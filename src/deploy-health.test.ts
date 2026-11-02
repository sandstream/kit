import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { checkDeployHealth, isPrivateAddress, parseDeployHealth } from "./deploy-health.js";

const SHA = "34d0351be5a77c051bab3e7684e75aa55dcb39f0";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** Run `fn` against a real loopback server and always close it, also when `fn` throws. */
async function withServer(
  handler: Handler,
  fn: (base: string, hits: () => number) => Promise<void>,
): Promise<void> {
  let count = 0;
  const server = createServer((req, res) => {
    count += 1;
    handler(req, res);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base, () => count);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
  }
}

function json(body: unknown, status = 200): Handler {
  return (_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
}

describe("parseDeployHealth", () => {
  it("reads one target per environment, with version_field defaulting to version", () => {
    const { targets, errors } = parseDeployHealth({
      health: { production: { url: "https://example.com/api/version" } },
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(targets, [
      {
        environment: "production",
        url: "https://example.com/api/version",
        versionField: "version",
      },
    ]);
  });

  it("returns nothing when [deploy.health] is absent", () => {
    assert.deepEqual(parseDeployHealth({ vercel: {} }), { targets: [], errors: [] });
    assert.deepEqual(parseDeployHealth(undefined), { targets: [], errors: [] });
  });

  it("refuses a plain http URL that is not loopback", () => {
    const { targets, errors } = parseDeployHealth({
      health: { production: { url: "http://example.com/v" } },
    });
    assert.equal(targets.length, 0);
    assert.match(errors[0].detail, /https/);
  });

  it("refuses a URL with credentials", () => {
    const { targets, errors } = parseDeployHealth({
      health: { production: { url: "https://user:pw@example.com/v" } },
    });
    assert.equal(targets.length, 0);
    assert.match(errors[0].detail, /credentials/);
  });

  it("reports a table without a url", () => {
    const { errors } = parseDeployHealth({ health: { production: {} } });
    assert.match(errors[0].detail, /url/);
  });
});

describe("checkDeployHealth", () => {
  it("reads the deployed commit from a real endpoint", async () => {
    await withServer(json({ version: SHA }), async (base) => {
      const rows = await checkDeployHealth(
        { health: { production: { url: `${base}/api/version` } } },
        { airGap: false, online: true, allowLoopback: true },
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "pass");
      assert.equal(rows[0].commit, SHA);
      assert.match(rows[0].detail, /34d0351/);
    });
  });

  it("reads a nested version_field", async () => {
    await withServer(json({ build: { sha: SHA } }), async (base) => {
      const rows = await checkDeployHealth(
        { health: { production: { url: base, version_field: "build.sha" } } },
        { airGap: false, online: true, allowLoopback: true },
      );
      assert.equal(rows[0].commit, SHA);
    });
  });

  it("says unverified, not pass, when the endpoint reports dev", async () => {
    await withServer(json({ version: "dev" }), async (base) => {
      const [row] = await checkDeployHealth(
        { health: { production: { url: base } } },
        { airGap: false, online: true, allowLoopback: true },
      );
      assert.equal(row.status, "warn");
      assert.equal(row.commit, undefined);
      assert.match(row.detail, /unverified/);
    });
  });
});

describe("checkDeployHealth failures", () => {
  it("says unverified on a 500, on non-JSON and on an oversize body", async () => {
    const cases: Handler[] = [
      json({ version: SHA }, 500),
      (_req, res) => res.end("<html>not json</html>"),
      (_req, res) => res.end(JSON.stringify({ version: SHA, pad: "x".repeat(200_000) })),
    ];
    for (const handler of cases) {
      await withServer(handler, async (base) => {
        const [row] = await checkDeployHealth(
          { health: { production: { url: base } } },
          { airGap: false, online: true, allowLoopback: true },
        );
        assert.equal(row.status, "warn");
        assert.equal(row.commit, undefined);
        assert.match(row.detail, /unverified/);
      });
    }
  });

  it("does not follow a redirect", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" });
        res.end();
      },
      async (base) => {
        const [row] = await checkDeployHealth(
          { health: { production: { url: base } } },
          { airGap: false, online: true, allowLoopback: true },
        );
        assert.equal(row.status, "warn");
        assert.match(row.detail, /redirect/);
      },
    );
  });

  it("says unverified when the host is unreachable", async () => {
    const [row] = await checkDeployHealth(
      { health: { production: { url: "http://127.0.0.1:1/v" } } },
      { airGap: false, online: true, allowLoopback: true, timeoutMs: 2000 },
    );
    assert.equal(row.status, "warn");
    assert.match(row.detail, /unverified/);
  });

  it("makes no request in air-gap mode", async () => {
    await withServer(json({ version: SHA }), async (base, hits) => {
      const [row] = await checkDeployHealth(
        { health: { production: { url: base } } },
        { airGap: true, online: true, allowLoopback: true },
      );
      assert.equal(row.status, "skip");
      assert.equal(hits(), 0);
    });
  });
});

describe("kit check deploy with [deploy.health]", () => {
  it("adds the deployed commit row from a real .kit.toml", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { loadConfig } = await import("./config.js");
    const { checkDeploy } = await import("./check-deploy.js");
    const { rmTemp } = await import("./temp-cleanup.test-support.js");
    await withServer(json({ version: SHA }), async (base) => {
      const dir = mkdtempSync(join(tmpdir(), "kit-deploy-health-"));
      try {
        writeFileSync(
          join(dir, ".kit.toml"),
          `[deploy.health.production]\nurl = "${base}/api/version"\n`,
        );
        const config = await loadConfig(join(dir, ".kit.toml"));
        const rows = await checkDeploy(config.deploy, dir, { online: true, allowLoopback: true });
        const health = rows.filter((r) => r.provider === "health");
        assert.equal(health.length, 1);
        assert.equal(health[0].status, "pass");
        assert.match(health[0].detail, /34d0351/);
      } finally {
        rmTemp(dir);
      }
    });
  });
});

describe("checkDeployHealth refuses to reach where the repository points it", () => {
  it("makes no request without --online", async () => {
    await withServer(json({ version: SHA }), async (base, hits) => {
      const [row] = await checkDeployHealth(
        { health: { production: { url: base } } },
        { airGap: false, online: false, allowLoopback: true },
      );
      assert.equal(row.status, "skip");
      assert.match(row.detail, /--online/);
      assert.equal(hits(), 0);
    });
  });

  it("refuses plain http to loopback unless the test option allows it", () => {
    const { targets, errors } = parseDeployHealth({
      health: { production: { url: "http://127.0.0.1:8080/v" } },
    });
    assert.equal(targets.length, 0);
    assert.match(errors[0].detail, /https/);
  });

  it("does not read private, link-local, metadata or loopback https hosts", async () => {
    const hosts = [
      "10.0.0.5",
      "192.168.1.1",
      "172.16.0.9",
      "169.254.169.254",
      "127.0.0.1",
      "[::1]",
      "[fe80::1]",
      "[::ffff:127.0.0.1]",
      "localhost",
    ];
    for (const host of hosts) {
      const [row] = await checkDeployHealth(
        { health: { production: { url: `https://${host}/v` } } },
        { airGap: false, online: true, timeoutMs: 2000 },
      );
      assert.equal(row.status, "warn", host);
      assert.match(row.detail, /not a public address/, host);
    }
  });
});

describe("isPrivateAddress", () => {
  it("lets public addresses through, IPv4 and IPv6, also IPv4-mapped", () => {
    for (const a of [
      "216.198.79.1",
      "64.29.17.1",
      "8.8.8.8",
      "2606:4700::1111",
      "::ffff:8.8.8.8",
    ]) {
      assert.equal(isPrivateAddress(a), false, a);
    }
  });

  it("blocks private, link-local, metadata, loopback and mapped private addresses", () => {
    for (const a of [
      "10.1.2.3",
      "172.31.0.1",
      "192.168.0.1",
      "100.64.0.1",
      "169.254.169.254",
      "127.0.0.1",
      "0.0.0.0",
      "::1",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:a9fe:a9fe",
      "not-an-ip",
    ]) {
      assert.equal(isPrivateAddress(a), true, a);
    }
  });
});

describe("kit check deploy air-gap from the project's own config", () => {
  it("reads no URL when the project's .kit.toml enables air_gap", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { loadConfig } = await import("./config.js");
    const { checkDeploy } = await import("./check-deploy.js");
    const { rmTemp } = await import("./temp-cleanup.test-support.js");
    await withServer(json({ version: SHA }), async (base, hits) => {
      const dir = mkdtempSync(join(tmpdir(), "kit-deploy-health-airgap-"));
      try {
        writeFileSync(
          join(dir, ".kit.toml"),
          `[air_gap]\nenabled = true\n\n[deploy.health.production]\nurl = "${base}/v"\n`,
        );
        const config = await loadConfig(join(dir, ".kit.toml"));
        const rows = await checkDeploy(config.deploy, dir, { online: true, allowLoopback: true });
        assert.equal(rows.filter((r) => r.provider === "health")[0].status, "skip");
        assert.equal(hits(), 0);
      } finally {
        rmTemp(dir);
      }
    });
  });
});
