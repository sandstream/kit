/**
 * One place that answers, per tool: where it is, who installed it, what version is there, and
 * what the newest version would be.
 *
 * Three surfaces needed the same four facts and none of them had them (#500):
 *
 *   - `cli-lock.json` recorded the DECLARED pin as the version and a hardcoded `source: "mise"`,
 *     so it said `mise` for `/opt/homebrew/bin/vercel`;
 *   - `kit check`'s tools table printed `✓ … (need latest)` without ever asking what latest is;
 *   - nothing at all inventoried the tools agents actually decide from (`gh`, `op`, `jq`,
 *     `docker`, `gcloud`, …) because they are not in `[tools]`.
 *
 * So the facts live here, measured once, and the surfaces render them. The undeclared list is
 * deliberately opinionated rather than "everything on PATH": it is the set whose output an agent
 * treats as authority, which is the reason an unnoticed six-major drift costs a wrong decision
 * rather than a slow build.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolveToolBin } from "./utils/resolveTool.js";
import { classifyToolPath, type ToolProvenance, type ToolSource } from "./tool-provenance.js";
import {
  latestVersion,
  judgeDrift,
  type DriftVerdict,
  type LatestCache,
  type LatestDeps,
} from "./tool-latest.js";
import { execFileNoThrow } from "./utils/execFileNoThrow.js";

/**
 * Tools whose output an agent treats as authority, beyond whatever `[tools]` declares.
 *
 * Not "everything on PATH": an inventory nobody reads is the failure mode one level up. These
 * are the ones that answer questions a session then acts on — identity, deploy state, secrets,
 * cluster state, data.
 */
export const AGENT_RELEVANT_TOOLS = [
  "gh",
  "op",
  "jq",
  "mise",
  "docker",
  "gcloud",
  "kubectl",
  "supabase",
  "stripe",
  "psql",
  "git",
  "node",
  "npm",
  "python3",
  "vercel",
  "convex",
] as const;

export interface ToolFacts {
  name: string;
  /** The pin from `[tools]`, when the tool is declared. */
  declared?: string;
  path: string | null;
  provenance: ToolProvenance | null;
  installed: string | null;
  /** Only computed when asked for — a lookup per tool is not free. */
  currency?: DriftVerdict;
}

/**
 * The binary name to probe for a declared tool.
 *
 * `[tools]` declarations carry a backend prefix — `aqua:aquasecurity/trivy`,
 * `npm:@socketsecurity/cli`, `pipx:lizard` — and the executable is named after the last path
 * segment, not the declaration. Probing the raw string reported installed tools as
 * "not installed", which is the same false statement as the one this arc is closing, pointed
 * the other way.
 */
export function probeName(declaration: string): string {
  const withoutBackend = declaration.includes(":")
    ? declaration.slice(declaration.indexOf(":") + 1)
    : declaration;
  const last = withoutBackend.split("/").filter(Boolean).pop() ?? withoutBackend;
  return last.replace(/^@/, "");
}

/** Read a tool's version the way the check does: run it and take the first version token. */
export async function readToolVersion(bin: string): Promise<string | null> {
  const r = await execFileNoThrow(bin, ["--version"], { timeout: 10_000 });
  if (!r.ok) return null;
  const m = (r.stdout || r.stderr || "").match(/(\d+[\d.]*)/);
  return m ? m[1] : null;
}

/** Where the latest-version cache lives. Per machine, not per repo: the answer is machine-wide. */
export function latestCachePath(): string {
  return join(process.env.KIT_AUDIT_ANCHOR_DIR ?? join(homedir(), ".kit"), "tool-latest.json");
}

/** Real dependencies for the latest lookups: subprocess, clock, on-disk TTL cache, air-gap. */
export async function realLatestDeps(): Promise<LatestDeps> {
  const { isAirGapPosture } = await import("./update-check.js");
  const offline = await isAirGapPosture();
  const path = latestCachePath();
  return {
    offline,
    now: () => Date.now(),
    ttlHours: Number.parseFloat(process.env.KIT_TOOL_LATEST_TTL_H ?? "") || undefined,
    run: async (cmd, args) => {
      const r = await execFileNoThrow(cmd, [...args], { timeout: 20_000 });
      return { ok: r.ok, stdout: r.stdout ?? "" };
    },
    readCache: async () => {
      try {
        return JSON.parse(await readFile(path, "utf-8")) as LatestCache;
      } catch {
        return {};
      }
    },
    writeCache: async (cache) => {
      try {
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, JSON.stringify(cache, null, 2) + "\n", { mode: 0o600 });
      } catch {
        /* a cache we cannot write is a slower check, not a failed one */
      }
    },
  };
}

/**
 * A currency checker for the GATE: reads the cache, never fills it.
 *
 * `kit check` must not shell out to four registries — requirement 6 of #500 is that the check
 * stays fast and offline-safe. So the gate reports drift the moment the cache knows about it
 * (warmed by `kit tools list --latest`, or a cron), and otherwise says it has not been looked up.
 * Silence would be the old false green with extra steps.
 */
export async function cachedCurrencyChecker(): Promise<
  (tool: string, source: ToolSource, installed: string | null) => Promise<DriftVerdict>
> {
  const deps = { ...(await realLatestDeps()), cacheOnly: true };
  return async (tool, source, installed) =>
    judgeDrift(installed, await latestVersion(probeName(tool), source, deps));
}

/** Measure one tool. `withCurrency` gates the (possibly networked) latest lookup. */
export async function describeTool(
  name: string,
  opts: { declared?: string; withCurrency?: boolean; deps?: LatestDeps } = {},
): Promise<ToolFacts> {
  const path = await resolveToolBin(probeName(name));
  const provenance = path ? classifyToolPath(path, { home: homedir() }) : null;
  const installed = path ? await readToolVersion(path) : null;
  const facts: ToolFacts = { name, declared: opts.declared, path, provenance, installed };
  if (opts.withCurrency && provenance) {
    const deps = opts.deps ?? (await realLatestDeps());
    facts.currency = judgeDrift(
      installed,
      await latestVersion(probeName(name), provenance.source, deps),
    );
  }
  return facts;
}

/**
 * The full inventory: declared tools plus the agent-relevant ones found on PATH.
 *
 * Declared tools win on name collision — the pin is the interesting fact about them.
 */
export async function inventoryTools(
  declared: Record<string, string> = {},
  opts: { withCurrency?: boolean; deps?: LatestDeps } = {},
): Promise<ToolFacts[]> {
  const names = new Set<string>([...Object.keys(declared), ...AGENT_RELEVANT_TOOLS]);
  const out: ToolFacts[] = [];
  for (const name of [...names].sort()) {
    const facts = await describeTool(name, {
      declared: declared[name],
      withCurrency: opts.withCurrency,
      deps: opts.deps,
    });
    // An undeclared tool that is not installed is not news; a declared one that is missing is.
    if (facts.path === null && declared[name] === undefined) continue;
    out.push(facts);
  }
  return out;
}

/** The lock's narrower source vocabulary. */
export type LockSource = "mise" | "npm" | "pip" | "manual";

/** Map a measured installer onto what `cli-lock.json` can express. */
export function toLockSource(source: ToolSource | undefined): LockSource {
  switch (source) {
    case "mise":
    case "asdf":
      return "mise";
    case "npm-global":
      return "npm";
    case "pipx":
      return "pip";
    case undefined:
      return "manual";
    default:
      // brew / system / cargo / go / kit-shim / unknown have no lock vocabulary of their own.
      return "manual";
  }
}

/**
 * Lock entries for the declared tools, with the version and source MEASURED.
 *
 * The resolved version is recorded when the tool is installed; when it is not, the declared pin
 * is kept so the entry still says what was asked for. `sourceDetail` carries the installer kit
 * actually saw, because the lock's four-value vocabulary cannot say "brew".
 */
export async function resolveLockEntries(
  declared: Record<string, string>,
): Promise<
  Record<string, { version: string; source: LockSource; sourceDetail?: string; path?: string }>
> {
  const out: Record<
    string,
    { version: string; source: LockSource; sourceDetail?: string; path?: string }
  > = {};
  for (const [name, pin] of Object.entries(declared)) {
    const facts = await describeTool(name);
    out[name] = {
      version: facts.installed ?? pin,
      source: toLockSource(facts.provenance?.source),
      sourceDetail: facts.provenance?.source,
      path: facts.path ?? undefined,
    };
  }
  return out;
}
