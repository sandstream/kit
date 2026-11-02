import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExecResult } from "../utils/execFileNoThrow.js";
import type { ServiceEntry } from "./registry.js";
import {
  containersFor,
  dockerSnapshot,
  parseDockerTime,
  parseMemUsage,
  parsePsOutput,
  probeEntry,
  stopEntry,
  unregisteredGroups,
  type DockerContainer,
  type DockerSnapshot,
  type ProbeDeps,
} from "./probe.js";

const result = (stdout: string, ok = true): ExecResult => ({
  stdout,
  stderr: ok ? "" : "boom",
  exitCode: ok ? 0 : 1,
  ok,
});

function deps(run: ProbeDeps["run"], extra: Partial<ProbeDeps> = {}): ProbeDeps {
  return { run, pidAlive: () => false, portOpen: async () => false, platform: "linux", ...extra };
}

function entry(kind: ServiceEntry["kind"], ref: string): ServiceEntry {
  return {
    name: "svc",
    kind,
    ref,
    project: "/repo",
    owner: { agent: "claude", session: "s1" },
    startedAt: "2026-11-01T10:00:00Z",
    leaseUntil: "2026-11-01T14:00:00Z",
  };
}

const containers: DockerContainer[] = [
  { id: "aaa111aaa111", name: "db", supabase: "shop" },
  { id: "bbb222bbb222", name: "api", compose: "web" },
  { id: "ccc333ccc333", name: "smoke" },
];
const up: DockerSnapshot = { available: true, containers };

describe("parsing docker output", () => {
  it("reads memory use as bytes", () => {
    assert.equal(parseMemUsage("512MiB / 7.6GiB"), 512 * 1024 ** 2);
    assert.equal(parseMemUsage("1.5GB / 8GB"), 1.5e9);
    assert.equal(parseMemUsage("garbage"), undefined);
  });

  it("reads a docker CreatedAt stamp with its offset", () => {
    const t = parseDockerTime("2026-06-10 12:34:56 +0200 CEST");
    assert.equal(t, Date.parse("2026-06-10T12:34:56+02:00"));
    assert.equal(parseDockerTime("not a date"), undefined);
  });

  it("splits ps rows into containers with labels", () => {
    const row = "abc\tdb,db-alias\tshop\t\t2026-06-10 12:34:56 +0200 CEST";
    const [c] = parsePsOutput(`${row}\n\n`);
    assert.equal(c?.name, "db");
    assert.equal(c?.supabase, "shop");
    assert.equal(c?.compose, undefined);
    assert.equal(typeof c?.createdAt, "number");
  });
});

describe("dockerSnapshot", () => {
  it("reports docker as unavailable with the first error line", async () => {
    const snap = await dockerSnapshot(deps(async () => result("", false)));
    assert.deepEqual(snap, { available: false, reason: "boom" });
  });

  it("adds memory from docker stats, matching a short id by prefix", async () => {
    const run: ProbeDeps["run"] = async (_cmd, args) =>
      args[0] === "ps" ? result("abcdef123456\tdb\t\t\t") : result("abcdef12\t100MiB / 1GiB");
    const snap = await dockerSnapshot(deps(run), { stats: true });
    assert.ok(snap.available);
    assert.equal(snap.containers[0]?.memBytes, 100 * 1024 ** 2);
  });

  it("keeps the containers when docker stats fails", async () => {
    const run: ProbeDeps["run"] = async (_cmd, args) =>
      args[0] === "ps" ? result("abc\tdb\t\t\t") : result("", false);
    const snap = await dockerSnapshot(deps(run), { stats: true });
    assert.ok(snap.available);
    assert.equal(snap.containers[0]?.memBytes, undefined);
  });
});

describe("probing entries", () => {
  it("finds the containers each docker kind owns", () => {
    assert.equal(containersFor(entry("supabase", "shop"), up)[0]?.name, "db");
    assert.equal(containersFor(entry("compose", "web"), up)[0]?.name, "api");
    assert.equal(containersFor(entry("container", "smoke"), up)[0]?.id, "ccc333ccc333");
    assert.deepEqual(containersFor(entry("pid", "1"), up), []);
  });

  it("reads a docker entry as unknown, never dead, when docker is down", async () => {
    const down: DockerSnapshot = { available: false, reason: "down" };
    assert.equal(
      await probeEntry(
        entry("supabase", "shop"),
        down,
        deps(async () => result("")),
      ),
      "unknown",
    );
  });

  it("probes pid and port entries without docker", async () => {
    const d = deps(async () => result(""), { pidAlive: () => true, portOpen: async () => true });
    assert.equal(await probeEntry(entry("pid", "42"), up, d), "alive");
    assert.equal(await probeEntry(entry("port", "5432"), up, d), "alive");
    assert.equal(await probeEntry(entry("compose", "gone"), up, d), "dead");
  });
});

describe("unregisteredGroups", () => {
  it("groups what no entry claims, biggest memory first", () => {
    const snap: DockerSnapshot = {
      available: true,
      containers: [
        { id: "1", name: "a", supabase: "shop", memBytes: 10 },
        { id: "2", name: "b", supabase: "shop", memBytes: 20 },
        { id: "3", name: "lone", memBytes: 500 },
        { id: "4", name: "claimed" },
      ],
    };
    const groups = unregisteredGroups([entry("container", "claimed")], snap);
    assert.deepEqual(
      groups.map((g) => [g.kind, g.ref, g.containers, g.memBytes]),
      [
        ["container", "lone", 1, 500],
        ["supabase", "shop", 2, 30],
      ],
    );
  });
});

describe("stopEntry", () => {
  it("uses the stop command that fits each kind", async () => {
    const calls: string[] = [];
    const run: ProbeDeps["run"] = async (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      return result("");
    };
    await stopEntry(entry("supabase", "shop"), deps(run));
    await stopEntry(entry("compose", "web"), deps(run));
    await stopEntry(entry("container", "smoke"), deps(run));
    assert.deepEqual(calls, [
      "supabase stop --project-id shop",
      "docker compose -p web down",
      "docker rm -f smoke",
    ]);
  });

  it("reports a failed stop with the last lines of its error", async () => {
    const out = await stopEntry(
      entry("container", "x"),
      deps(async () => result("", false)),
    );
    assert.equal(out.ok, false);
    assert.match(out.detail, /docker rm -f failed: boom/);
  });

  it("refuses a port entry because kit does not know the owning process", async () => {
    const out = await stopEntry(
      entry("port", "5432"),
      deps(async () => result("")),
    );
    assert.equal(out.ok, false);
    assert.match(out.detail, /cannot stop a port entry/);
  });

  it("ends a process tree with taskkill on Windows", async () => {
    const calls: string[] = [];
    const run: ProbeDeps["run"] = async (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      return result("");
    };
    const out = await stopEntry(entry("pid", "99"), deps(run, { platform: "win32" }));
    assert.equal(out.ok, true);
    assert.deepEqual(calls, ["taskkill /PID 99 /T /F"]);
  });
});
