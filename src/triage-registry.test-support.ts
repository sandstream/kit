import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** A local HTTP server that answers as crates.io, the Go module proxy and OSV, from a route table. */
export interface StubRegistry {
  url: string;
  /** Path -> JSON value (sent as JSON) or string (sent as text). An unknown path is a 404. */
  routes: Record<string, unknown>;
  /** OSV records returned for every `/v1/query`. */
  vulns: { id: string }[];
  /** Every request received, as `METHOD path`. */
  asked: string[];
  /** The User-Agent of every request. */
  agents: string[];
  close: () => Promise<void>;
}

export async function startStubRegistry(
  routes: Record<string, unknown> = {},
): Promise<StubRegistry> {
  const stub: StubRegistry = { url: "", routes, vulns: [], asked: [], agents: [], close };
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0]!;
    stub.asked.push(`${req.method} ${path}`);
    stub.agents.push(String(req.headers["user-agent"] ?? ""));
    req.resume();
    if (path === "/v1/query") return void res.end(JSON.stringify({ vulns: stub.vulns }));
    if (!Object.hasOwn(stub.routes, path)) {
      res.statusCode = 404;
      return void res.end("not found");
    }
    const body = stub.routes[path];
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  function close(): Promise<void> {
    server.closeAllConnections();
    return new Promise((done) => server.close(() => done()));
  }
  return stub;
}

/** A port nothing listens on: every request to it fails, as an unreachable registry does. */
export const UNREACHABLE = "http://127.0.0.1:9";

const DAY_MS = 86_400_000;
export const daysAgo = (days: number, now = Date.now()) =>
  new Date(now - days * DAY_MS).toISOString();

/** A crates.io crate document with the given `[version, ageDays, yanked?]` rows. */
export function crateDoc(rows: [string, number, boolean?][], downloads = 50_000, stable?: string) {
  return {
    crate: { downloads, max_stable_version: stable ?? rows[0]?.[0] },
    versions: rows.map(([num, age, yanked]) => ({
      num,
      created_at: daysAgo(age),
      yanked: yanked === true,
    })),
  };
}
