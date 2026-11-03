/** Fixtures for triage-cooling.test.ts: a local registry and OSV, and the report triage.py would print. */

import { before, after, beforeEach } from "node:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  applyCooling,
  defaultCoolingDeps,
  type CoolingDeps,
  type OsvVuln,
} from "./triage-cooling.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

/** Kept out of the template string that uses it: a comment opener in a template misleads the complexity scanner. */
const LOCALHOST = "http://127.0.0.1";

export const iso = (daysAgo: number): string =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString();

export function tree(spec: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-cooling-"));
  for (const [rel, content] of Object.entries(spec)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

export const lock = (version: string) =>
  JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/fixture": { version } } });

/** An OSV record: an advisory that affects versions below `fixed`. */
export const vuln = (id: string, fixed?: string): OsvVuln => ({
  id,
  affected: [
    {
      package: { name: "fixture" },
      ranges: [
        {
          type: "SEMVER",
          events: [{ introduced: "0" }, ...(fixed ? [{ fixed }] : [])],
        },
      ],
    },
  ],
});

/** triage.py's report for a version, as runTriage hands it to applyCooling. */
export const report = (version: string) =>
  [
    "Triage: npm fixture",
    "--------------------------------------------------",
    `  . triaged ${version}, 3 versions, 2 maintainer(s)`,
    "",
    "Health score: 100/100",
    "Critical issues: 0",
    "Warnings: 0",
    "Probes declared unavailable: 0",
    "TRIAGE PASSED",
    "",
  ].join("\n");

/** A local registry and OSV, started once for the calling describe block and reset before each test. */
export function localServices() {
  let server: Server;
  let base = "";
  const registry = new Map<string, unknown>();
  /** OSV answers by name@version. */
  const osv = new Map<string, OsvVuln[]>();
  const state = { down: false, calls: 0 };
  const dirs: string[] = [];

  before(async () => {
    server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/v1/query") {
        state.calls++;
        if (state.down) {
          res.writeHead(503).end("down");
          return;
        }
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          const q = JSON.parse(raw) as { package: { name: string }; version: string };
          const vulns = osv.get(`${q.package.name}@${q.version}`) ?? [];
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(vulns.length ? { vulns } : {}));
        });
        return;
      }
      const body = registry.get(req.url ?? "");
      res.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(body ?? {}));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("no fixture port");
    base = `${LOCALHOST}:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    for (const d of dirs) rmTemp(d);
  });

  beforeEach(() => {
    registry.clear();
    osv.clear();
    state.down = false;
    state.calls = 0;
  });

  /** The packument: published maps a version to the days ago it was published. */
  const publish = (published: Record<string, number>, latest: string) =>
    registry.set("/fixture", {
      "dist-tags": { latest },
      versions: Object.fromEntries(Object.keys(published).map((v) => [v, { version: v }])),
      time: Object.fromEntries(Object.entries(published).map(([v, d]) => [v, iso(d)])),
    });

  const project = (files: Record<string, string>): string => {
    const dir = tree(files);
    dirs.push(dir);
    return dir;
  };

  const run = (cwd: string, version: string, env: Record<string, string> = {}, airGap = false) => {
    const deps: CoolingDeps = {
      ...defaultCoolingDeps,
      env: { KIT_NPM_REGISTRY: base, KIT_OSV_API: base, ...env },
      airGap: async () => ({ enabled: airGap, mirrors: {} }),
    };
    return applyCooling(cwd, "npm", "fixture", { passed: true, output: report(version) }, deps);
  };
  return { registry, osv, state, publish, project, run, url: () => base };
}
