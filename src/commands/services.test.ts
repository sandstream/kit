/**
 * `kit services`, driven through runServices with a fake docker. No docker runs in CI, and the
 * behaviour under test is kit's: the merge of registry and probes, the lease and ownership rules,
 * the ask / keep / release loop, and that stop verifies before it drops an entry.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTemp } from "../temp-cleanup.test-support.js";
import { runServices, statusOf, type ServicesDeps } from "./services.js";
import { readRegistry, type ServiceEntry } from "../services/registry.js";
import type { ExecResult } from "../utils/execFileNoThrow.js";
import type { ProbeDeps } from "../services/probe.js";

interface FakeContainer {
  id: string;
  name: string;
  supabase?: string;
  compose?: string;
  created?: string;
  mem?: string;
}

const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", exitCode: 0, ok: true });

class FakeDocker {
  containers: FakeContainer[] = [];
  available = true;
  /** When set, stop commands "succeed" but leave the containers running. */
  stubborn = false;
  calls: string[] = [];

  deps(): ProbeDeps {
    return {
      platform: "linux",
      pidAlive: () => false,
      portOpen: async () => false,
      run: (cmd, args) => this.run(cmd, args),
    };
  }

  private async run(cmd: string, args: string[]): Promise<ExecResult> {
    this.calls.push([cmd, ...args].join(" "));
    if (cmd === "docker" && !this.available) {
      return { stdout: "", stderr: "Cannot connect to the Docker daemon", exitCode: 1, ok: false };
    }
    const listing = this.listing(cmd, args);
    if (listing) return listing;
    if (this.stubborn) return ok();
    return (
      this.stop(cmd, args) ?? { stdout: "", stderr: `unexpected ${cmd}`, exitCode: 1, ok: false }
    );
  }

  private listing(cmd: string, args: string[]): ExecResult | undefined {
    if (cmd !== "docker") return undefined;
    if (args[0] === "ps") {
      const rows = this.containers.map((c) =>
        [c.id, c.name, c.supabase ?? "", c.compose ?? "", c.created ?? ""].join("\t"),
      );
      return ok(rows.join("\n"));
    }
    if (args[0] === "stats") {
      return ok(this.containers.map((c) => `${c.id}\t${c.mem ?? "0B / 1GiB"}`).join("\n"));
    }
    return undefined;
  }

  private stop(cmd: string, args: string[]): ExecResult | undefined {
    if (cmd === "docker" && args[0] === "rm") {
      this.containers = this.containers.filter((c) => c.name !== args[2]);
    } else if (cmd === "docker" && args[0] === "compose") {
      this.containers = this.containers.filter((c) => c.compose !== args[2]);
    } else if (cmd === "supabase") {
      this.containers = this.containers.filter((c) => c.supabase !== args[2]);
    } else {
      return undefined;
    }
    return ok();
  }
}

const CLAUDE_A = { CLAUDE_CODE_SESSION_ID: "aaaaaaaa-1111" };
const CLAUDE_B = { CLAUDE_CODE_SESSION_ID: "bbbbbbbb-2222" };
const CODEX_C = { CODEX_THREAD_ID: "cccccccc-3333", CLAUDE_CODE_SESSION_ID: "aaaaaaaa-1111" };

let dir: string;
let file: string;
let docker: FakeDocker;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kit-services-cmd-"));
  file = join(dir, "services.json");
  docker = new FakeDocker();
  clock = Date.parse("2026-11-01T10:00:00Z");
});
afterEach(() => rmTemp(dir));

async function kit(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ ok: boolean; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const d: ServicesDeps = {
    argv: ["node", "kit", "services", ...args],
    env,
    cwd: dir,
    now: () => clock,
    probe: docker.deps(),
    file,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  const result = await runServices(d);
  // Colour codes make assertions noisy; strip them.
  const strip = (s: string) => s.replace(/\x1b\[\d+m/g, "");
  return { ok: result, out: strip(out.join("\n")), err: strip(err.join("\n")) };
}

function entries(): ServiceEntry[] {
  return readRegistry(file).services;
}

describe("kit services add", () => {
  it("records kind, ref, owner session, project and a 4h lease by default", async () => {
    docker.containers.push({ id: "c1", name: "smoke" });
    const r = await kit(
      ["add", "smoke", "--kind", "container", "--ref", "smoke", "--purpose", "test"],
      CLAUDE_A,
    );
    assert.equal(r.ok, true, r.err);
    const [e] = entries();
    assert.equal(e!.kind, "container");
    assert.deepEqual(e!.owner, { agent: "claude", session: "aaaaaaaa-1111" });
    assert.equal(e!.purpose, "test");
    assert.equal(Date.parse(e!.leaseUntil) - clock, 4 * 3_600_000);
    assert.ok(e!.project.length > 0);
  });

  it("prefers the Codex thread id when both harnesses' variables are present", async () => {
    await kit(["add", "x", "--kind", "container", "--ref", "x"], CODEX_C);
    assert.deepEqual(entries()[0]!.owner, { agent: "codex", session: "cccccccc-3333" });
  });

  it("refuses a duplicate name, a bad kind, a bad ref and a bad ttl", async () => {
    assert.equal((await kit(["add", "x", "--kind", "container", "--ref", "x"], CLAUDE_A)).ok, true);
    const dup = await kit(["add", "x", "--kind", "container", "--ref", "y"], CLAUDE_B);
    assert.equal(dup.ok, false);
    assert.match(dup.err, /already registered/);
    assert.equal((await kit(["add", "y", "--kind", "vm", "--ref", "y"])).ok, false);
    assert.equal((await kit(["add", "y", "--kind", "container", "--ref", "a b"])).ok, false);
    assert.equal(
      (await kit(["add", "y", "--kind", "container", "--ref", "y", "--ttl", "9y"])).ok,
      false,
    );
    assert.equal(entries().length, 1);
  });

  it("rejects an unknown flag", async () => {
    const r = await kit(["ls", "--bogus"]);
    assert.equal(r.ok, false);
    assert.match(r.err, /unknown flag/);
  });
});

describe("kit services ls", () => {
  it("merges the registry with live probes and lists unregistered workloads", async () => {
    docker.containers.push(
      { id: "s1", name: "supabase_db_app", supabase: "app", mem: "1GiB / 8GiB" },
      { id: "s2", name: "supabase_kong_app", supabase: "app", mem: "512MiB / 8GiB" },
      {
        id: "o1",
        name: "supabase_db_old",
        supabase: "old",
        created: "2026-06-10 12:00:00 +0000 UTC",
        mem: "2GiB / 8GiB",
      },
      { id: "k1", name: "kit-test-1781113535409", created: "2026-06-10 12:00:00 +0000 UTC" },
      { id: "p1", name: "web-1", compose: "web" },
    );
    await kit(["add", "app", "--kind", "supabase", "--ref", "app"], CLAUDE_A);
    await kit(["add", "gone", "--kind", "container", "--ref", "gone"], CLAUDE_A);
    await kit(["add", "late", "--kind", "compose", "--ref", "web", "--ttl", "30m"], CLAUDE_A);
    clock += 60 * 60_000; // "late" lease has ended, its containers still run

    const json = await kit(["ls", "--json"]);
    const doc = JSON.parse(json.out) as {
      services: { name: string; status: string }[];
      unregistered: { kind: string; ref: string; containers: number; memBytes?: number }[];
    };
    const status = Object.fromEntries(doc.services.map((s) => [s.name, s.status]));
    assert.deepEqual(status, { app: "running", gone: "dead", late: "expired" });
    assert.deepEqual(
      doc.unregistered.map((g) => [g.kind, g.ref, g.containers]),
      [
        ["supabase", "old", 1],
        ["container", "kit-test-1781113535409", 1],
      ],
    );
    assert.equal(doc.unregistered[0]!.memBytes, 2 * 1024 ** 3);

    const text = await kit(["ls"]);
    assert.match(text.out, /Unregistered docker workloads \(unknown owner\)/);
    assert.match(text.out, /kit-test-1781113535409/);
    assert.match(text.out, /144d/); // 2026-06-10 to 2026-11-01
  });

  it("shows docker-backed entries as unknown, never dead, when docker is down", async () => {
    await kit(["add", "app", "--kind", "supabase", "--ref", "app"], CLAUDE_A);
    docker.available = false;
    const doc = JSON.parse((await kit(["ls", "--json"])).out) as {
      docker: { available: boolean };
      services: { status: string }[];
    };
    assert.equal(doc.docker.available, false);
    assert.equal(doc.services[0]!.status, "unknown");
    // prune must not drop what it cannot see.
    await kit(["prune"]);
    assert.equal(entries().length, 1);
  });

  it("statusOf: dead wins over expired, expired over running", () => {
    const e = { leaseUntil: "2026-11-01T09:00:00Z" } as ServiceEntry;
    assert.equal(statusOf(e, "dead", clock), "dead");
    assert.equal(statusOf(e, "alive", clock), "expired");
    assert.equal(statusOf({ ...e, leaseUntil: "2026-11-01T11:00:00Z" }, "alive", clock), "running");
  });
});

describe("kit services stop ownership", () => {
  beforeEach(() => {
    docker.containers.push({ id: "c1", name: "smoke" });
  });

  it("refuses a non-owner while the lease runs, and names the owner", async () => {
    await kit(
      ["add", "smoke", "--kind", "container", "--ref", "smoke", "--purpose", "e2e"],
      CLAUDE_A,
    );
    const r = await kit(["stop", "smoke"], CLAUDE_B);
    assert.equal(r.ok, false);
    assert.match(r.err, /refused/);
    assert.match(r.err, /claude:aaaaaaaa/);
    assert.match(r.err, /kit services ask smoke/);
    assert.equal(docker.containers.length, 1);
    assert.ok(!docker.calls.some((c) => c.startsWith("docker rm")));
  });

  it("lets the owner stop it, verifies it is gone, and removes the entry", async () => {
    await kit(["add", "smoke", "--kind", "container", "--ref", "smoke"], CLAUDE_A);
    const r = await kit(["stop", "smoke"], CLAUDE_A);
    assert.equal(r.ok, true, r.err);
    assert.match(r.out, /verified gone/);
    assert.equal(docker.containers.length, 0);
    assert.equal(entries().length, 0);
  });

  it("lets anyone stop it once the lease has ended", async () => {
    await kit(["add", "smoke", "--kind", "container", "--ref", "smoke", "--ttl", "30m"], CLAUDE_A);
    clock += 31 * 60_000;
    const r = await kit(["stop", "smoke"], CLAUDE_B);
    assert.equal(r.ok, true, r.err);
    assert.equal(docker.containers.length, 0);
  });

  it("--force overrides an active lease", async () => {
    await kit(["add", "smoke", "--kind", "container", "--ref", "smoke"], CLAUDE_A);
    assert.equal((await kit(["stop", "smoke", "--force"], CLAUDE_B)).ok, true);
  });

  it("keeps the entry when the service still runs after the stop command", async () => {
    await kit(["add", "smoke", "--kind", "container", "--ref", "smoke"], CLAUDE_A);
    docker.stubborn = true;
    const r = await kit(["stop", "smoke"], CLAUDE_A);
    assert.equal(r.ok, false);
    assert.match(r.err, /still runs/);
    assert.equal(entries().length, 1);
  });
});

describe("kit services stop with docker", () => {
  beforeEach(() => {
    docker.containers.push({ id: "c1", name: "smoke" });
  });

  it("refuses to stop anything when docker is down", async () => {
    await kit(["add", "smoke", "--kind", "container", "--ref", "smoke"], CLAUDE_A);
    docker.available = false;
    const r = await kit(["stop", "smoke"], CLAUDE_A);
    assert.equal(r.ok, false);
    assert.match(r.err, /docker is not reachable/);
    assert.equal(entries().length, 1);
  });

  it("stops a supabase stack with supabase stop --project-id and a compose project with down", async () => {
    docker.containers.push(
      { id: "s1", name: "supabase_db_app", supabase: "app" },
      { id: "w1", name: "web-1", compose: "web" },
    );
    await kit(["add", "app", "--kind", "supabase", "--ref", "app"], CLAUDE_A);
    await kit(["add", "web", "--kind", "compose", "--ref", "web"], CLAUDE_A);
    assert.equal((await kit(["stop", "app"], CLAUDE_A)).ok, true);
    assert.equal((await kit(["stop", "web"], CLAUDE_A)).ok, true);
    assert.ok(docker.calls.includes("supabase stop --project-id app"));
    assert.ok(docker.calls.includes("docker compose -p web down"));
  });

  it("refuses a port entry with an explanation", async () => {
    await kit(["add", "dev", "--kind", "port", "--ref", "5173"], CLAUDE_A);
    const r = await kit(["stop", "dev"], CLAUDE_A);
    assert.equal(r.ok, false);
    assert.match(r.err, /cannot stop a port entry/);
  });

  it("requires --force from a non-owner for a pid entry even after the lease", async () => {
    await kit(["add", "srv", "--kind", "pid", "--ref", "4242", "--ttl", "30m"], CLAUDE_A);
    clock += 31 * 60_000;
    const r = await kit(["stop", "srv"], CLAUDE_B);
    assert.equal(r.ok, false);
    assert.match(r.err, /reuses process ids/);
  });
});

describe("kit services ask / keep / release", () => {
  beforeEach(async () => {
    docker.containers.push({ id: "c1", name: "smoke" });
    await kit(["add", "smoke", "--kind", "container", "--ref", "smoke"], CLAUDE_A);
  });

  it("ask records the request; keep (owner) renews and clears it", async () => {
    const asked = await kit(["ask", "smoke", "--message", "swap is full"], CLAUDE_B);
    assert.equal(asked.ok, true, asked.err);
    assert.equal(entries()[0]!.stopRequest?.message, "swap is full");
    assert.equal(entries()[0]!.stopRequest?.by.session, "bbbbbbbb-2222");

    assert.equal((await kit(["keep", "smoke"], CLAUDE_B)).ok, false, "a non-owner cannot keep");
    clock += 60 * 60_000;
    const kept = await kit(["keep", "smoke"], CLAUDE_A);
    assert.equal(kept.ok, true, kept.err);
    assert.equal(entries()[0]!.stopRequest, undefined);
    assert.equal(Date.parse(entries()[0]!.leaseUntil) - clock, 4 * 3_600_000);
  });

  it("release (owner) stops it; a non-owner cannot release", async () => {
    await kit(["ask", "smoke"], CLAUDE_B);
    assert.equal((await kit(["release", "smoke"], CLAUDE_B)).ok, false);
    assert.equal(docker.containers.length, 1);
    const r = await kit(["release", "smoke"], CLAUDE_A);
    assert.equal(r.ok, true, r.err);
    assert.equal(docker.containers.length, 0);
    assert.equal(entries().length, 0);
  });

  it("an unanswered request leaves the service stoppable once the lease ends", async () => {
    await kit(["ask", "smoke"], CLAUDE_B);
    assert.equal((await kit(["stop", "smoke"], CLAUDE_B)).ok, false);
    clock += 4 * 3_600_000 + 1;
    assert.equal((await kit(["stop", "smoke"], CLAUDE_B)).ok, true);
  });

  it("renew is owner-only", async () => {
    assert.equal((await kit(["renew", "smoke"], CLAUDE_B)).ok, false);
    assert.equal((await kit(["renew", "smoke", "--ttl", "8h"], CLAUDE_A)).ok, true);
    assert.equal(Date.parse(entries()[0]!.leaseUntil) - clock, 8 * 3_600_000);
  });

  it("a plain terminal owns what it registered with the same --owner label", async () => {
    await kit(["add", "mine", "--kind", "container", "--ref", "smoke", "--owner", "peter"]);
    assert.equal((await kit(["renew", "mine"], {})).ok, false, "no label is someone else");
    assert.equal((await kit(["renew", "mine", "--owner", "peter"])).ok, true);
  });
});

describe("kit services prune", () => {
  it("drops dead entries and keeps running ones", async () => {
    docker.containers.push({ id: "c1", name: "alive" });
    await kit(["add", "alive", "--kind", "container", "--ref", "alive"], CLAUDE_A);
    await kit(["add", "dead", "--kind", "container", "--ref", "dead"], CLAUDE_A);
    const r = await kit(["prune"]);
    assert.equal(r.ok, true);
    assert.deepEqual(
      entries().map((e) => e.name),
      ["alive"],
    );
  });
});
