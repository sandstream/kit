import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { NpmArtifactFetchPolicy } from "./npm-artifact-fetch.js";

export const gzipBytes = Buffer.from("1f8b08000000000002ff4b4c4a0600c241243503000000", "hex");

export async function fetchInUnsafeEnvironment(
  source: string,
  policy: NpmArtifactFetchPolicy,
): Promise<unknown> {
  const moduleUrl = new URL("./npm-artifact-fetch.js", import.meta.url).href;
  const script = `
    import { fetchNpmTarball } from ${JSON.stringify(moduleUrl)};
    const result = await fetchNpmTarball(process.env.KIT_NPM_TEST_URL, JSON.parse(process.env.KIT_NPM_TEST_POLICY));
    process.stdout.write(JSON.stringify(result.status === "retrieved" ? { status: result.status, hex: result.bytes.toString("hex") } : result));
  `;
  // Built at run time so no credential-shaped literal sits in the source. The proxy is a fake that nothing listens on.
  const fakeProxy = ["http://fake-proxy-user", "fake-proxy-password"].join(":") + "@127.0.0.1:1";
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [...process.execArgv, "--input-type=module", "--eval", script],
    {
      timeout: 5000,
      maxBuffer: 65536,
      env: {
        ...process.env,
        NODE_OPTIONS: "",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
        NODE_USE_ENV_PROXY: "1",
        HTTPS_PROXY: fakeProxy,
        HTTP_PROXY: fakeProxy,
        NO_PROXY: "",
        npm_config_proxy: "http://127.0.0.1:1",
        npm_config_registry: "https://not-used.invalid",
        KIT_NPM_TEST_URL: source,
        KIT_NPM_TEST_POLICY: JSON.stringify(policy),
      },
    },
  );
  return JSON.parse(stdout);
}

async function makeCertificate(
  dir: string,
  hostMatches: boolean,
): Promise<{ key: Buffer; caPem: string }> {
  const config = [
    "[req]",
    "distinguished_name=dn",
    "x509_extensions=extensions",
    "prompt=no",
    "[dn]",
    "CN=kit-transport-test",
    "[extensions]",
    "basicConstraints=critical,CA:TRUE",
    "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign",
    "extendedKeyUsage=serverAuth",
    `subjectAltName=${hostMatches ? "IP:127.0.0.1" : "DNS:wrong.invalid"}`,
  ].join("\n");
  await writeFile(join(dir, "openssl.cnf"), config, { mode: 0o600 });
  // This is test-only material. No key is stored in the delivery or a personal store.
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-config",
      join(dir, "openssl.cnf"),
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
    ],
    {
      stdio: "pipe",
      timeout: 10000,
      env: { ...process.env, OPENSSL_CONF: join(dir, "openssl.cnf") },
    },
  );
  const [key, caPem] = await Promise.all([
    readFile(join(dir, "key.pem")),
    readFile(join(dir, "cert.pem"), "utf8"),
  ]);
  return { key, caPem };
}

async function closeFixture(server: Server | undefined, sockets: Set<Duplex>): Promise<void> {
  const closedSockets = [...sockets].map(
    (socket) => new Promise<void>((resolve) => socket.once("close", resolve)),
  );
  const closedServer = server?.listening
    ? new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      )
    : Promise.resolve();
  for (const socket of sockets) socket.destroy();
  await Promise.all([closedServer, ...closedSockets]);
  assert.equal(sockets.size, 0, "All fixture sockets must close");
}

export async function withHttps<T>(
  handle: (req: IncomingMessage, res: ServerResponse) => void,
  run: (fixture: {
    origin: string;
    caPem: string;
    server: Server;
    sockets: Set<Duplex>;
  }) => Promise<T>,
  hostMatches = true,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "kit-npm-transport-test-"));
  const sockets = new Set<Duplex>();
  let server: Server | undefined;
  try {
    const { key, caPem } = await makeCertificate(dir, hostMatches);
    server = createServer({ key, cert: caPem }, handle);
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => sockets.delete(socket));
    });
    server.on("tlsClientError", () => {});
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => {
        server!.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return await run({ origin: `https://127.0.0.1:${address.port}`, caPem, server, sockets });
  } finally {
    try {
      await closeFixture(server, sockets);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
