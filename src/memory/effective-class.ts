/**
 * The impure half of memory classification — the wire that was missing.
 *
 * `class.ts` holds the policy as pure functions and is fully unit-tested. What did not
 * exist was a caller: `resolveMemoryClass()` had **zero** production call sites,
 * `[memory] default_class` was read in zero places, and `KIT_MEMORY_CLASS` in zero.
 * Every row took the built-in default and the documented override did nothing. The
 * tests passed the whole time, which is exactly why `self-audit` rule 15 exists.
 *
 * This module supplies the env and the config so the policy runs on real inputs.
 *
 * Deliberately **observe-tier only**: it resolves and reports the class, and does not
 * yet filter recall. Turning on disclosure filtering changes what an existing store
 * returns — a wrong flip either leaks across projects or silently hides a user's own
 * notes — so it is a separate, explicitly-tested step on kit's own observe→enforce
 * ladder rather than a side effect of making the config readable.
 */

import { loadConfig } from "../config.js";
import { resolveConfigPath } from "../cli-shared.js";
import { resolveMemoryClass, type ClassResolution } from "./class.js";

/** The env var documented in the README and in `config.ts`'s `default_class` comment. */
export const MEMORY_CLASS_ENV = "KIT_MEMORY_CLASS";

/**
 * Resolve the class this project/session actually operates under.
 *
 * Precedence is the policy's, not this module's: `KIT_MEMORY_CLASS` → `[memory]
 * default_class` → the documented default. An invalid value fails closed to
 * `restricted` and comes back with `recognized: false`, so a caller can say so instead
 * of silently widening or narrowing disclosure.
 *
 * Config load failure is not a security event by itself — it resolves from env and the
 * default, which is the same answer a project with no `[memory]` section gets.
 */
export async function effectiveMemoryClass(): Promise<ClassResolution> {
  let configured: unknown;
  try {
    const config = await loadConfig(resolveConfigPath());
    configured = config.memory?.default_class;
  } catch {
    configured = undefined;
  }
  return resolveMemoryClass({ env: process.env[MEMORY_CLASS_ENV], configured });
}

/**
 * One line an operator can read: which class applies and where it came from. An
 * unrecognized value says so out loud — a typo that failed closed to `restricted` is
 * worth seeing, because the row it labels cannot be recalled into a lesser context
 * once filtering is enabled.
 */
export function formatClassResolution(r: ClassResolution): string {
  const origin =
    r.source === "env"
      ? `${MEMORY_CLASS_ENV}`
      : r.source === "config"
        ? "[memory] default_class"
        : "built-in default";
  const suffix = r.recognized ? "" : " — UNRECOGNIZED value, failed closed";
  return `${r.cls} (from ${origin})${suffix}`;
}
