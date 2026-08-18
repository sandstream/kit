/**
 * User-level init defaults — the operator's standing preferences, applied by
 * `kit init` on BOTH surfaces (the CLI flow and the MCP `kit_init` tool):
 * the services you actually use (e.g. sentry + posthog), offered as candidates
 * for a new project rather than added to it. Detection decides what a repo gets;
 * this file only decides what you are asked about.
 *
 * Lives OUTSIDE any repo (`~/.kit/defaults.toml`) because it is personal taste,
 * not project truth — the generated `.kit.toml` remains the single source the
 * repo commits, and a teammate without the defaults file gets identical checks
 * from that committed config. Fail-safe by construction: a missing file is the
 * normal case, a malformed file or unknown service id degrades to "no defaults
 * applied" (unknown ids are REPORTED, never silently dropped) — defaults must
 * not be able to break init. `KIT_DEFAULTS_FILE` overrides the path (tests).
 *
 *   # ~/.kit/defaults.toml
 *   [init]
 *   known_services = ["sentry", "posthog"]   # offered, not applied
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { SERVICE_BY_ID } from "./service-registry.js";
import type { DetectedStack } from "./stack-detector.js";

export function userDefaultsPath(): string {
  return process.env.KIT_DEFAULTS_FILE ?? join(homedir(), ".kit", "defaults.toml");
}

export interface UserInitDefaults {
  /** Known service ids declared in the file (registry-validated) — a menu, not a decision. */
  services: string[];
  /** Declared ids kit's registry does not know — reported to the user, never applied. */
  unknown: string[];
  /** True when the file still uses the old `services` key rather than `known_services`. */
  legacyKey: boolean;
}

const EMPTY: UserInitDefaults = { services: [], unknown: [], legacyKey: false };

export function loadUserInitDefaults(): UserInitDefaults {
  let raw: string;
  try {
    raw = readFileSync(userDefaultsPath(), "utf-8");
  } catch {
    return EMPTY; // no defaults file — the common case
  }
  try {
    // `known_services` is the current key; `services` is the same list under its old
    // name and is still read, so an existing defaults file keeps working. What changed
    // is not the list but what kit does with it — offer, no longer append.
    const doc = parse(raw) as { init?: { known_services?: unknown; services?: unknown } };
    const declaredRaw = doc.init?.known_services ?? doc.init?.services;
    const legacyKey = doc.init?.known_services === undefined && doc.init?.services !== undefined;
    const declared = Array.isArray(declaredRaw)
      ? declaredRaw.filter((s): s is string => typeof s === "string")
      : [];
    const services: string[] = [];
    const unknown: string[] = [];
    for (const id of declared) (id in SERVICE_BY_ID ? services : unknown).push(id);
    return { services, unknown, legacyKey };
  } catch {
    return EMPTY; // malformed toml — degrade to no defaults, never break init
  }
}

export interface ServiceSelection {
  /** The stack carrying exactly the services that will be written. */
  stack: DetectedStack;
  /** Services the repo itself evidences (dependencies, config files). */
  detected: string[];
  /** Known services NOT evidenced here — candidates, offered but not applied. */
  offered: string[];
  /** Services added beyond detection because they were explicitly chosen. */
  applied: string[];
  /** Declared-but-unknown ids, passed through for the caller to surface. */
  unknown: string[];
  /** The defaults file still uses the pre-menu `services` key. */
  legacyKey: boolean;
}

/**
 * Decide which services a NEW project gets.
 *
 * The user's known services used to be appended to every project unconditionally, which
 * put a `[services.posthog]` block and three POSTHOG keys into repos with no PostHog in
 * them. Being the operator's own list made it feel authoritative; it was still a claim
 * about a repo that nothing in the repo supports.
 *
 * So the list became a menu. Detected services are applied — the repo proves those. Known
 * ones that are absent here are returned as `offered` for the caller to put to whoever can
 * answer (a prompt at a terminal, a gap for an agent). `chosen`, when given, is that answer
 * and replaces the selection outright, so an explicit `--services ""` really does mean none.
 */
export function resolveInitServices(stack: DetectedStack, chosen?: string[]): ServiceSelection {
  const { services: known, unknown, legacyKey } = loadUserInitDefaults();
  const detected = stack.services;

  if (chosen) {
    const valid = chosen.filter((s) => s in SERVICE_BY_ID);
    const bogus = chosen.filter((s) => !(s in SERVICE_BY_ID));
    return {
      stack: { ...stack, services: valid },
      detected,
      offered: [],
      applied: valid.filter((s) => !detected.includes(s)),
      unknown: [...unknown, ...bogus],
      legacyKey,
    };
  }

  return {
    stack,
    detected,
    offered: known.filter((s) => !detected.includes(s)),
    applied: [],
    unknown,
    legacyKey,
  };
}
