# kit health (v1a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `kit health` — a deterministic, read-only command that probes the project's connected external systems and mirrors red findings into PAL — with one real sensor (GitHub Actions) proving the full spine end to end.

**Architecture:** A pure orchestrator (`runHealth`) maps over a registry of `HealthSensor` objects; each sensor owns its own probe (via injected `HealthDeps`) and a *pure* parse function that is unit-tested against captured CLI output. Red findings are mirrored into the existing PAL ledger via the same `palSyncFindings` path the security findings already use, under a new `"health"` source tag so reconciliation never touches other sources. The `kit health` CLI command wraps it with the existing `withGovernance` read wrapper and a `--json` mode mirroring `cmdStatus`/`cmdCheck`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node 22+ `node:test` + `node:assert/strict`, the repo's `execFileNoThrow` exec wrapper, `node:sqlite`-backed PAL store.

## Scope

This plan is the first slice of the `kit health` portion of the kit-sentinel
spec (`docs/specs/2026-06-21-kit-sentinel-design.md`, layer 1). It deliberately
ships **framework + GitHub Actions sensor + PAL mirror + CLI** only. The other
sensors (Vercel, Sentry, Supabase, Resend, TLS cert) are mechanical follow-ons
— each is one `HealthSensor` entry plus a pure-parse test reusing the
framework this plan builds — and are listed in the Appendix as separate future
plans (the HTTP/token probe path lands with the first HTTP sensor). Layers 2
(the responder routine) and 3 (`kit sentinel install` + SessionStart surface)
are out of scope for this plan.

**Spec deviation (deliberate):** the spec sketched a `healthProbe` field on
`ServiceDef`. We do NOT modify `ServiceDef`. It is pure data (and has a
byte-identical-output guarantee in its tests); a sensor needs a `parse`
*function*, which does not belong in a data registry. Instead sensors live in
their own `HEALTH_SENSORS` registry keyed by service id. Adding a sensor is
still a single entry — the spec's intent ("a data row") holds; only the file
changes.

## Global Constraints

- **Public repo / no internal leaks.** This is the public `sandstream/kit`
  repo. Never write internal product names, customer names, or private hosts
  into code, tests, fixtures, comments, or commit messages. Fixtures use
  generic names (e.g. `acme/webapp`). A pre-commit `no-internal-leaks` hook
  enforces this.
- **Node >= 22.0.0.** ESM only; all relative imports end in `.js`.
- **Zero-LLM.** `kit health` is deterministic and read-only. No probe mutates
  anything; no network write; no LLM call.
- **Account-verified detection.** A sensor that cannot confirm *which*
  account/org/ref it is probing returns a finding with `status: "unknown"` and
  the reason — never `"green"`. A skipped/errored probe is `"unknown"`, never
  silently dropped.
- **Exec safety.** External commands run via `execFileNoThrow(command, args,
  opts)` with arguments as an array. Never build a shell string.
- **Tests:** `node:test` + `node:assert/strict`; import compiled siblings with
  `.js`. Per-file TDD loop: `node --test --import tsx src/<file>.test.ts`.
  Authoritative run before commit: `npm run build && npm test`.

---

### Task 1: Health core types + orchestrator

**Files:**
- Create: `src/health.ts`
- Test: `src/health.test.ts`

**Interfaces:**
- Consumes: nothing (foundation).
- Produces:
  - `type HealthStatus = "green" | "red" | "unknown"`
  - `type HealthClass = "code" | "human" | "noise"`
  - `interface HealthFinding { sensor: string; source: string; status: HealthStatus; severity?: "critical" | "high" | "medium" | "low"; title: string; detail?: string; suggestedClass?: HealthClass }`
  - `interface HealthCtx { cwd: string; config: kitConfig }`
  - `interface HealthDeps { runCli(command: string, args: string[]): Promise<ExecResult> }`
  - `interface HealthSensor { id: string; probe(ctx: HealthCtx, deps: HealthDeps): Promise<HealthFinding[]> }`
  - `async function runHealth(ctx: HealthCtx, sensors: HealthSensor[], deps: HealthDeps): Promise<HealthFinding[]>`

- [ ] **Step 1: Write the failing test**

```typescript
// src/health.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runHealth, type HealthSensor, type HealthCtx, type HealthDeps } from "./health.js";

const ctx: HealthCtx = { cwd: "/tmp/repo", config: {} };
const deps: HealthDeps = { runCli: async () => ({ stdout: "", stderr: "", exitCode: 0, ok: true }) };

describe("runHealth", () => {
  it("aggregates findings from all sensors", async () => {
    const a: HealthSensor = { id: "a", probe: async () => [{ sensor: "a", source: "x", status: "green", title: "ok" }] };
    const b: HealthSensor = { id: "b", probe: async () => [{ sensor: "b", source: "y", status: "red", severity: "high", title: "bad" }] };
    const out = await runHealth(ctx, [a, b], deps);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((f) => f.status).sort(), ["green", "red"]);
  });

  it("converts a throwing sensor into an unknown finding, never drops it", async () => {
    const boom: HealthSensor = { id: "boom", probe: async () => { throw new Error("network down"); } };
    const out = await runHealth(ctx, [boom], deps);
    assert.equal(out.length, 1);
    assert.equal(out[0].status, "unknown");
    assert.equal(out[0].sensor, "boom");
    assert.match(out[0].detail ?? "", /network down/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx src/health.test.ts`
Expected: FAIL — `Cannot find module './health.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/health.ts
import type { kitConfig } from "./config.js";
import type { ExecResult } from "./utils/execFileNoThrow.js";

export type HealthStatus = "green" | "red" | "unknown";
export type HealthClass = "code" | "human" | "noise";

export interface HealthFinding {
  sensor: string;
  /** The account/org/ref/repo actually probed (the verify-source record). */
  source: string;
  status: HealthStatus;
  severity?: "critical" | "high" | "medium" | "low";
  title: string;
  detail?: string;
  suggestedClass?: HealthClass;
}

export interface HealthCtx {
  cwd: string;
  config: kitConfig;
}

export interface HealthDeps {
  runCli(command: string, args: string[]): Promise<ExecResult>;
}

export interface HealthSensor {
  id: string;
  probe(ctx: HealthCtx, deps: HealthDeps): Promise<HealthFinding[]>;
}

/** Runs every sensor; a sensor that throws becomes an `unknown` finding (never dropped). */
export async function runHealth(
  ctx: HealthCtx,
  sensors: HealthSensor[],
  deps: HealthDeps,
): Promise<HealthFinding[]> {
  const all = await Promise.all(
    sensors.map(async (s): Promise<HealthFinding[]> => {
      try {
        return await s.probe(ctx, deps);
      } catch (e) {
        return [{
          sensor: s.id,
          source: "(probe errored)",
          status: "unknown",
          title: `${s.id} probe failed`,
          detail: e instanceof Error ? e.message : String(e),
        }];
      }
    }),
  );
  return all.flat();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx src/health.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/health.ts src/health.test.ts
git commit -m "feat(health): core types + runHealth orchestrator"
```

---

### Task 2: GitHub Actions sensor

**Files:**
- Create: `src/health-sensors/github-actions.ts`
- Test: `src/health-sensors/github-actions.test.ts`

**Interfaces:**
- Consumes: `HealthFinding`, `HealthSensor`, `HealthCtx`, `HealthDeps` from `../health.js`.
- Produces:
  - `interface GhRun { name: string; status: string; conclusion: string; createdAt: string; databaseId: number }`
  - `function parseGitHubRuns(json: string): GhRun[]`
  - `function failingWorkflows(runs: GhRun[]): { name: string; createdAt: string }[]` — latest completed run per workflow name; included when its conclusion is `"failure"`, `"timed_out"`, or `"startup_failure"`.
  - `const githubActionsSensor: HealthSensor` (id `"github-actions"`).

**Probe behavior:** the sensor (a) resolves the repo via `gh repo view --json nameWithOwner` to get the real `owner/repo` (the verify-source record); if `ctx.config.context?.github?.org` is set and does not match the repo owner, it returns a single `unknown` finding (context/repo mismatch — never reports green against the wrong account); (b) runs `gh run list --limit 30 --json name,status,conclusion,createdAt,databaseId`; (c) emits one `red` finding per failing workflow (severity `high`, class `code`) plus, when none fail, a single `green` finding. A non-zero `gh` exit (not authed / no remote) yields one `unknown` finding.

- [ ] **Step 1: Write the failing test**

```typescript
// src/health-sensors/github-actions.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseGitHubRuns,
  failingWorkflows,
  githubActionsSensor,
} from "./github-actions.js";
import type { HealthCtx, HealthDeps } from "../health.js";

const runs = JSON.stringify([
  { name: "CI", status: "completed", conclusion: "failure", createdAt: "2026-06-21T06:50:00Z", databaseId: 9 },
  { name: "CI", status: "completed", conclusion: "success", createdAt: "2026-06-20T06:50:00Z", databaseId: 8 },
  { name: "Security", status: "completed", conclusion: "success", createdAt: "2026-06-21T05:00:00Z", databaseId: 7 },
]);

function deps(over: Partial<Record<string, { stdout: string; ok: boolean }>> = {}): HealthDeps {
  return {
    runCli: async (cmd, args) => {
      const key = `${cmd} ${args[0]}`;
      const r = over[key];
      if (r) return { stdout: r.stdout, stderr: "", exitCode: r.ok ? 0 : 1, ok: r.ok };
      return { stdout: "", stderr: "", exitCode: 0, ok: true };
    },
  };
}
const ctx: HealthCtx = { cwd: "/tmp/repo", config: {} };

describe("parseGitHubRuns / failingWorkflows", () => {
  it("keeps only the latest completed run per workflow and flags failures", () => {
    const parsed = parseGitHubRuns(runs);
    assert.equal(parsed.length, 3);
    const failing = failingWorkflows(parsed);
    assert.deepEqual(failing.map((f) => f.name), ["CI"]); // newest CI is failure; Security is green
  });

  it("returns [] when the JSON is empty", () => {
    assert.deepEqual(failingWorkflows(parseGitHubRuns("[]")), []);
  });
});

describe("githubActionsSensor.probe", () => {
  it("emits one red finding per failing workflow", async () => {
    const out = await githubActionsSensor.probe(ctx, deps({
      "gh repo": { stdout: JSON.stringify({ nameWithOwner: "acme/webapp" }), ok: true },
      "gh run": { stdout: runs, ok: true },
    }));
    const red = out.filter((f) => f.status === "red");
    assert.equal(red.length, 1);
    assert.equal(red[0].sensor, "github-actions");
    assert.equal(red[0].source, "acme/webapp");
    assert.equal(red[0].suggestedClass, "code");
    assert.match(red[0].title, /CI/);
  });

  it("emits a single green finding when nothing fails", async () => {
    const allGreen = JSON.stringify([
      { name: "CI", status: "completed", conclusion: "success", createdAt: "2026-06-21T06:50:00Z", databaseId: 9 },
    ]);
    const out = await githubActionsSensor.probe(ctx, deps({
      "gh repo": { stdout: JSON.stringify({ nameWithOwner: "acme/webapp" }), ok: true },
      "gh run": { stdout: allGreen, ok: true },
    }));
    assert.equal(out.length, 1);
    assert.equal(out[0].status, "green");
  });

  it("returns unknown when gh is not authed", async () => {
    const out = await githubActionsSensor.probe(ctx, deps({
      "gh repo": { stdout: "", ok: false },
    }));
    assert.equal(out.length, 1);
    assert.equal(out[0].status, "unknown");
  });

  it("returns unknown on context/repo owner mismatch", async () => {
    const out = await githubActionsSensor.probe(
      { cwd: "/tmp/repo", config: { context: { github: { org: "otherorg" } } } },
      deps({ "gh repo": { stdout: JSON.stringify({ nameWithOwner: "acme/webapp" }), ok: true } }),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].status, "unknown");
    assert.match(out[0].detail ?? "", /otherorg/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx src/health-sensors/github-actions.test.ts`
Expected: FAIL — `Cannot find module './github-actions.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/health-sensors/github-actions.ts
import type { HealthCtx, HealthDeps, HealthFinding, HealthSensor } from "../health.js";

export interface GhRun {
  name: string;
  status: string;
  conclusion: string;
  createdAt: string;
  databaseId: number;
}

const FAIL_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);

export function parseGitHubRuns(json: string): GhRun[] {
  try {
    const arr = JSON.parse(json) as GhRun[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** Latest completed run per workflow name; included when that run failed. */
export function failingWorkflows(runs: GhRun[]): { name: string; createdAt: string }[] {
  const latest = new Map<string, GhRun>();
  for (const r of runs) {
    if (r.status !== "completed") continue;
    const cur = latest.get(r.name);
    if (!cur || r.createdAt > cur.createdAt) latest.set(r.name, r);
  }
  return [...latest.values()]
    .filter((r) => FAIL_CONCLUSIONS.has(r.conclusion))
    .map((r) => ({ name: r.name, createdAt: r.createdAt }));
}

export const githubActionsSensor: HealthSensor = {
  id: "github-actions",
  async probe(ctx: HealthCtx, deps: HealthDeps): Promise<HealthFinding[]> {
    const repoRes = await deps.runCli("gh", ["repo", "view", "--json", "nameWithOwner"]);
    if (!repoRes.ok) {
      return [{
        sensor: "github-actions",
        source: "(no gh auth / no remote)",
        status: "unknown",
        title: "GitHub Actions probe could not resolve the repo",
        detail: "gh repo view failed — run `gh auth status`",
      }];
    }
    let nwo = "";
    try {
      nwo = (JSON.parse(repoRes.stdout) as { nameWithOwner: string }).nameWithOwner ?? "";
    } catch {
      nwo = "";
    }
    const wantOrg = ctx.config.context?.github?.org;
    if (wantOrg && nwo && nwo.split("/")[0] !== wantOrg) {
      return [{
        sensor: "github-actions",
        source: nwo,
        status: "unknown",
        title: "GitHub repo does not match locked context org",
        detail: `context expects org "${wantOrg}" but gh repo is "${nwo}"`,
      }];
    }

    const listRes = await deps.runCli("gh", [
      "run", "list", "--limit", "30",
      "--json", "name,status,conclusion,createdAt,databaseId",
    ]);
    if (!listRes.ok) {
      return [{
        sensor: "github-actions",
        source: nwo || "(unknown repo)",
        status: "unknown",
        title: "GitHub Actions run list failed",
        detail: listRes.stderr || "gh run list returned non-zero",
      }];
    }

    const failing = failingWorkflows(parseGitHubRuns(listRes.stdout));
    if (failing.length === 0) {
      return [{
        sensor: "github-actions",
        source: nwo,
        status: "green",
        title: "GitHub Actions: all workflows green",
      }];
    }
    return failing.map((w) => ({
      sensor: "github-actions",
      source: nwo,
      status: "red" as const,
      severity: "high" as const,
      title: `GitHub Actions workflow failing: ${w.name}`,
      detail: `latest run of "${w.name}" failed (${w.createdAt})`,
      suggestedClass: "code" as const,
    }));
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx src/health-sensors/github-actions.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/health-sensors/github-actions.ts src/health-sensors/github-actions.test.ts
git commit -m "feat(health): GitHub Actions sensor (failing-workflow detection)"
```

---

### Task 3: Sensor selection + default deps

**Files:**
- Modify: `src/health.ts` (append `selectSensors` and `defaultHealthDeps`)
- Test: `src/health.test.ts` (append)

**Interfaces:**
- Consumes: `githubActionsSensor` from `./health-sensors/github-actions.js`; `execFileNoThrow` from `./utils/execFileNoThrow.js`.
- Produces:
  - `const HEALTH_SENSORS: HealthSensor[]` — the registry (github-actions only, for now).
  - `function selectSensors(ctx: HealthCtx): HealthSensor[]` — returns the subset whose service is connected. github-actions is connected when a `.git` dir exists OR `ctx.config.context?.github` is set OR `ctx.config.services?.github` exists. For this slice, gate it on the presence of `ctx.config.context?.github` OR a `github`/git remote signal passed in config; default to including github-actions when `gitRemote` is true.
  - `const defaultHealthDeps: HealthDeps` — wraps `execFileNoThrow` with a 15s timeout.

To keep selection testable without filesystem access, `selectSensors` reads a
boolean `ctx.gitRemote` added to `HealthCtx`. The CLI layer (Task 5) computes
`gitRemote` from the real repo.

- [ ] **Step 1: Write the failing test (append to src/health.test.ts)**

```typescript
import { selectSensors, defaultHealthDeps, HEALTH_SENSORS } from "./health.js";

describe("selectSensors", () => {
  it("includes github-actions when a git remote is present", () => {
    const sel = selectSensors({ cwd: "/tmp/repo", config: {}, gitRemote: true });
    assert.ok(sel.some((s) => s.id === "github-actions"));
  });

  it("excludes github-actions with no git remote and no github context", () => {
    const sel = selectSensors({ cwd: "/tmp/repo", config: {}, gitRemote: false });
    assert.equal(sel.some((s) => s.id === "github-actions"), false);
  });

  it("registry is non-empty and defaultHealthDeps exposes runCli", () => {
    assert.ok(HEALTH_SENSORS.length >= 1);
    assert.equal(typeof defaultHealthDeps.runCli, "function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx src/health.test.ts`
Expected: FAIL — `selectSensors`/`HEALTH_SENSORS`/`defaultHealthDeps` are not exported.

- [ ] **Step 3: Implement**

Add `gitRemote?: boolean` to the `HealthCtx` interface in `src/health.ts`:

```typescript
export interface HealthCtx {
  cwd: string;
  config: kitConfig;
  /** True when the repo has a git remote (computed by the CLI layer). */
  gitRemote?: boolean;
}
```

Append to `src/health.ts`:

```typescript
import { githubActionsSensor } from "./health-sensors/github-actions.js";
import { execFileNoThrow } from "./utils/execFileNoThrow.js";

export const HEALTH_SENSORS: HealthSensor[] = [githubActionsSensor];

/** Returns the sensors whose underlying service the project is connected to. */
export function selectSensors(ctx: HealthCtx): HealthSensor[] {
  return HEALTH_SENSORS.filter((s) => {
    if (s.id === "github-actions") {
      return ctx.gitRemote === true || ctx.config.context?.github !== undefined;
    }
    return false;
  });
}

export const defaultHealthDeps: HealthDeps = {
  runCli: (command, args) => execFileNoThrow(command, args, { timeout: 15_000 }),
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx src/health.test.ts`
Expected: PASS (5 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/health.ts src/health.test.ts
git commit -m "feat(health): sensor registry, connected-service selection, default deps"
```

---

### Task 4: Mirror red findings into PAL

**Files:**
- Create: `src/health-track.ts`
- Test: `src/health-track.test.ts`

**Interfaces:**
- Consumes: `HealthFinding` from `./health.js`; `palSyncFindings`, `SyncFinding` from `./memory/pal.js`; `openMemoryDb` from `./memory/db.js`; `getCurrentProjectRoot` from `./memory/project.js`.
- Produces:
  - `function actionableHealth(findings: HealthFinding[]): HealthFinding[]` — only `status === "red"`.
  - `function healthFindingToSync(f: HealthFinding): SyncFinding` — `dedupKey = "${f.sensor}:${f.title}"`, `title = f.title`, `detail = f.detail`.
  - `async function syncHealthFindings(findings: HealthFinding[]): Promise<{ added: number; reopened: number; closed: string[] } | null>` — mirrors `syncSecurityFindings`; source tag `"health"`; scope = `basename(getCurrentProjectRoot())`; fail-open (returns `null` on any error).

This mirrors `src/findings-track.ts` exactly, with source tag `"health"` so a
re-sync only reconciles `health-*` PAL ids — green/disappeared findings
auto-close, other sources untouched.

- [ ] **Step 1: Write the failing test**

```typescript
// src/health-track.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { actionableHealth, healthFindingToSync } from "./health-track.js";
import type { HealthFinding } from "./health.js";

const findings: HealthFinding[] = [
  { sensor: "github-actions", source: "acme/webapp", status: "red", severity: "high", title: "workflow failing: CI", detail: "latest CI failed" },
  { sensor: "github-actions", source: "acme/webapp", status: "green", title: "all green" },
  { sensor: "github-actions", source: "acme/webapp", status: "unknown", title: "probe errored" },
];

describe("actionableHealth", () => {
  it("keeps only red findings (green + unknown are not action items)", () => {
    const out = actionableHealth(findings);
    assert.equal(out.length, 1);
    assert.equal(out[0].title, "workflow failing: CI");
  });
});

describe("healthFindingToSync", () => {
  it("produces a stable dedup key of sensor:title", () => {
    const s = healthFindingToSync(findings[0]);
    assert.equal(s.dedupKey, "github-actions:workflow failing: CI");
    assert.equal(s.title, "workflow failing: CI");
    assert.equal(s.detail, "latest CI failed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx src/health-track.test.ts`
Expected: FAIL — `Cannot find module './health-track.js'`.

- [ ] **Step 3: Implement**

```typescript
// src/health-track.ts
import type { HealthFinding } from "./health.js";
import type { SyncFinding } from "./memory/pal.js";

export function actionableHealth(findings: HealthFinding[]): HealthFinding[] {
  return findings.filter((f) => f.status === "red");
}

export function healthFindingToSync(f: HealthFinding): SyncFinding {
  return {
    dedupKey: `${f.sensor}:${f.title}`,
    title: f.title,
    detail: f.detail || undefined,
  };
}

/** Mirror red health findings into PAL under the "health" source tag. Fail-open. */
export async function syncHealthFindings(
  findings: HealthFinding[],
): Promise<{ added: number; reopened: number; closed: string[] } | null> {
  try {
    const { openMemoryDb } = await import("./memory/db.js");
    const { palSyncFindings } = await import("./memory/pal.js");
    const { getCurrentProjectRoot } = await import("./memory/project.js");
    const { basename } = await import("node:path");
    const scope = basename(getCurrentProjectRoot());
    const db = openMemoryDb();
    try {
      return palSyncFindings(db, "health", actionableHealth(findings).map(healthFindingToSync), {
        scope,
      });
    } finally {
      db.close();
    }
  } catch {
    return null; // fail-open: health reporting must never break a command
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx src/health-track.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/health-track.ts src/health-track.test.ts
git commit -m "feat(health): mirror red findings into PAL under the health source tag"
```

---

### Task 5: `kit health` CLI command

**Files:**
- Modify: `src/cli.ts` (add `cmdHealth`; register `health: cmdHealth` in the `COMMANDS` table near line 4716)
- Test: `src/cli-health.test.ts`

**Interfaces:**
- Consumes: `runHealth`, `selectSensors`, `defaultHealthDeps`, `HealthFinding`, `HealthCtx` from `./health.js`; `syncHealthFindings` from `./health-track.js`; existing `loadConfig`, `resolveConfigPath`, `withGovernance`, `hasFlag`, `c` (colors), `execFileNoThrow`.
- Produces: a new exported pure formatter `function formatHealth(findings: HealthFinding[]): { lines: string[]; redCount: number }` (in `src/health.ts`) so the human output is unit-testable without the CLI wiring; and `cmdHealth(): Promise<boolean>` (returns `false` when any red finding exists, so the command exit code reflects health).

First add `formatHealth` to `src/health.ts`:

- [ ] **Step 1: Write the failing test for the formatter**

```typescript
// src/cli-health.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatHealth, type HealthFinding } from "./health.js";

const findings: HealthFinding[] = [
  { sensor: "github-actions", source: "acme/webapp", status: "red", severity: "high", title: "workflow failing: CI" },
  { sensor: "github-actions", source: "acme/webapp", status: "green", title: "all green" },
  { sensor: "x", source: "y", status: "unknown", title: "probe errored" },
];

describe("formatHealth", () => {
  it("counts red findings and renders a line per finding", () => {
    const out = formatHealth(findings);
    assert.equal(out.redCount, 1);
    assert.equal(out.lines.length, 3);
    assert.ok(out.lines.some((l) => l.includes("workflow failing: CI")));
    assert.ok(out.lines.some((l) => l.includes("acme/webapp")));
  });

  it("redCount is 0 when nothing is red", () => {
    const out = formatHealth([{ sensor: "a", source: "s", status: "green", title: "ok" }]);
    assert.equal(out.redCount, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx src/cli-health.test.ts`
Expected: FAIL — `formatHealth` is not exported.

- [ ] **Step 3: Implement `formatHealth` in `src/health.ts`**

```typescript
// append to src/health.ts
const MARK: Record<HealthStatus, string> = { green: "✓", red: "✗", unknown: "?" };

/** Pure human formatter — returns lines + red count (CLI adds color). */
export function formatHealth(findings: HealthFinding[]): { lines: string[]; redCount: number } {
  const lines = findings.map(
    (f) => `${MARK[f.status]} [${f.sensor}] ${f.title}  (${f.source})`,
  );
  const redCount = findings.filter((f) => f.status === "red").length;
  return { lines, redCount };
}
```

- [ ] **Step 4: Run formatter test to verify it passes**

Run: `node --test --import tsx src/cli-health.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add `cmdHealth` to `src/cli.ts`**

Add the handler (place it beside `cmdCheck`/`cmdStatus`):

```typescript
async function cmdHealth(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");
  const config = await loadConfig(resolveConfigPath());

  return await withGovernance(
    config,
    { operation: "health", operationType: "read", metadata: {} },
    async () => {
      const { runHealth, selectSensors, defaultHealthDeps, formatHealth } = await import("./health.js");
      const { syncHealthFindings } = await import("./health-track.js");

      // git remote presence (drives sensor selection)
      const remote = await execFileNoThrow("git", ["remote"], { timeout: 5_000 });
      const ctx = { cwd: process.cwd(), config, gitRemote: remote.ok && remote.stdout.trim().length > 0 };

      const sensors = selectSensors(ctx);
      const findings = await runHealth(ctx, sensors, defaultHealthDeps);
      await syncHealthFindings(findings); // mirror red into PAL (fail-open)

      if (jsonMode) {
        const redCount = findings.filter((f) => f.status === "red").length;
        console.log(JSON.stringify({ ok: redCount === 0, findings }, null, 2));
        return redCount === 0;
      }

      const { lines, redCount } = formatHealth(findings);
      console.log(`${c.bold}kit health${c.reset}  ${c.dim}${sensors.length} sensor(s)${c.reset}`);
      if (findings.length === 0) {
        console.log(`  ${c.dim}no connected external systems detected${c.reset}`);
      }
      for (const line of lines) {
        const color = line.startsWith("✗") ? c.red : line.startsWith("?") ? c.yellow : c.green;
        console.log(`  ${color}${line}${c.reset}`);
      }
      if (redCount > 0) console.log(`${c.red}${redCount} red${c.reset}`);
      return redCount === 0;
    },
  );
}
```

Register it in the `COMMANDS` table (near cli.ts:4716):

```typescript
  health: cmdHealth,
```

- [ ] **Step 6: Build and run the full suite**

Run: `npm run build && npm test`
Expected: build clean; all tests pass including the new `health`, `github-actions`, `health-track`, and `cli-health` suites.

- [ ] **Step 7: Manual smoke (this repo has a git remote + red CI)**

Run: `node --test` is not needed here; instead:
`npm run build && node dist/cli.js health`
Expected: prints `kit health  1 sensor(s)` and a `✗ [github-actions] GitHub Actions workflow failing: …` line (this repo currently has red workflows). `node dist/cli.js health --json` prints the findings array with `"status": "red"`. Exit code non-zero.

- [ ] **Step 8: Commit**

```bash
git add src/cli.ts src/health.ts src/cli-health.test.ts
git commit -m "feat(health): kit health command (--json + human, governance read, PAL mirror)"
```

---

## Self-review

- **Spec coverage (layer 1 slice):** deterministic read-only probe command
  (Tasks 1,5); connected-service-derived sensors (Task 3 selection; Task 2
  sensor); account-verified, `unknown`-not-green (Task 2 mismatch + not-authed
  cases, Task 1 throw→unknown); red→PAL mirror with dedup + auto-close (Task 4
  reuses `palSyncFindings`); `--json` + human (Task 5). Remaining spec sensors
  + layers 2/3 are explicitly out of this plan's scope (Appendix).
- **Placeholders:** none — every code/test step is complete.
- **Type consistency:** `HealthFinding`/`HealthSensor`/`HealthCtx`/`HealthDeps`
  defined in Task 1 and reused verbatim in Tasks 2–5; `SyncFinding` consumed in
  Task 4 matches `src/memory/pal.ts`; `ExecResult` matches
  `src/utils/execFileNoThrow.ts`; `gitRemote?` added to `HealthCtx` in Task 3
  and consumed in Task 5.

## Appendix — follow-up sensors (separate future plans)

Each is one `HealthSensor` added to `HEALTH_SENSORS` plus a pure-parse test,
reusing this framework. The first HTTP-based sensor also adds an `httpGet` to
`HealthDeps`.

- **Vercel** (HTTP): GET `/v6/deployments?projectId=<id>&target=production&limit=1`
  with `VERCEL_TOKEN`; projectId from `.vercel/project.json`; red when latest
  prod deployment `readyState` is `ERROR`/`CANCELED`. Class: code.
- **Sentry** (HTTP): issues search for new unresolved since last sweep, scoped
  to the org/project from `[context]`/env; red or noise. Needs `SENTRY_AUTH_TOKEN`.
- **Supabase**: Security Advisor + migration drift for the project ref from
  `[context]`/`NEXT_PUBLIC_SUPABASE_URL`. Class: code or human.
- **Resend** (HTTP): GET `/domains` with `RESEND_API_KEY`; red/human when a
  domain status is not `verified`. Class: human.
- **TLS cert** (CLI): `openssl s_client` expiry window for a configured host
  list (`[health] cert_hosts`); human/infra. (Adds the one bit of new config.)
