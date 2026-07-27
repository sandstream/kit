/**
 * User-level init defaults — the operator's standing preferences, applied by
 * `kit init` on BOTH surfaces (the CLI flow and the MCP `kit_init` tool):
 * services you always want in a new project (e.g. sentry + posthog), regardless
 * of what stack detection finds in the dependencies.
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
 *   services = ["sentry", "posthog"]
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
  /** Known service ids declared in the file (registry-validated). */
  services: string[];
  /** Declared ids kit's registry does not know — reported to the user, never applied. */
  unknown: string[];
}

const EMPTY: UserInitDefaults = { services: [], unknown: [] };

export function loadUserInitDefaults(): UserInitDefaults {
  let raw: string;
  try {
    raw = readFileSync(userDefaultsPath(), "utf-8");
  } catch {
    return EMPTY; // no defaults file — the common case
  }
  try {
    const doc = parse(raw) as { init?: { services?: unknown } };
    const declared = Array.isArray(doc.init?.services)
      ? doc.init.services.filter((s): s is string => typeof s === "string")
      : [];
    const services: string[] = [];
    const unknown: string[] = [];
    for (const id of declared) (id in SERVICE_BY_ID ? services : unknown).push(id);
    return { services, unknown };
  } catch {
    return EMPTY; // malformed toml — degrade to no defaults, never break init
  }
}

export interface AppliedDefaults {
  stack: DetectedStack;
  /** Default services actually added (not already detected). */
  applied: string[];
  /** Declared-but-unknown ids, passed through for the caller to surface. */
  unknown: string[];
}

/** Merge the user's default services into a detected stack (append, dedupe). */
export function applyUserInitDefaults(stack: DetectedStack): AppliedDefaults {
  const { services, unknown } = loadUserInitDefaults();
  const applied = services.filter((s) => !stack.services.includes(s));
  if (applied.length === 0) return { stack, applied, unknown };
  return { stack: { ...stack, services: [...stack.services, ...applied] }, applied, unknown };
}
