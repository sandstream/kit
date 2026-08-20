import type { ToolConfig } from "./config.js";
import { exec } from "./utils/exec.js";
import { resolveToolBin } from "./utils/resolveTool.js";
import { homedir } from "node:os";
import { classifyToolPath, type ToolSource } from "./tool-provenance.js";
import { probeName } from "./tool-inventory.js";
import type { DriftVerdict } from "./tool-latest.js";

/** Resolve a tool name to its executable path (mise-first), or null. */
export type ToolResolver = (tool: string) => Promise<string | null>;

export interface ToolStatus {
  name: string;
  required: string;
  installed: string | null;
  /** Satisfies the declared pin. Unchanged meaning — every existing consumer reads this. */
  ok: boolean;
  /** Resolved executable path, when known. */
  path?: string;
  /** Which installer owns that path (measured, never assumed). */
  source?: ToolSource;
  /**
   * Currency, for a pin that promises it (`latest`). `undefined` when the pin does not ask:
   * an exact pin is about matching, not about being newest.
   *
   * `behind` is a WARNING, not a failure — the tool works, it is just old. But it must be
   * visible: `✓ vercel 53.1.1 (need latest)` was printed for six majors of drift (#500).
   * `unknown` carries the reason the lookup could not answer, and never reads as current.
   */
  currency?: DriftVerdict;
}

/** How a `latest` pin gets its answer. Injected so `checkTools` stays offline in tests. */
export type CurrencyChecker = (
  tool: string,
  source: ToolSource,
  installed: string | null,
) => Promise<DriftVerdict>;

async function getToolVersion(tool: string, resolve: ToolResolver): Promise<string | null> {
  // Fast path: `mise current` gives the project-pinned version directly when the
  // tool is declared in the project's mise config.
  try {
    const { stdout } = await exec("mise", ["current", tool], {
      timeout: 10_000,
    });
    const version = stdout.trim().split(/\s+/)[0];
    if (version) return version;
  } catch {
    // mise doesn't pin this tool in-project — fall through
  }

  // Resolve the binary mise-first, then read its version. `resolveToolBin` uses
  // `mise which` (which finds `mise use -g` globals even when mise isn't activated
  // in the shell, so its shims aren't on PATH) before falling back to PATH. Without
  // this, a globally mise-installed tool (e.g. semgrep/trivy) reports "not installed".
  const bin = await resolve(tool);
  if (!bin) return null;
  try {
    const { stdout: ver } = await exec(bin, ["--version"], {
      timeout: 10_000,
    });
    const match = ver.match(/(\d+[\d.]*)/);
    return match ? match[1] : "unknown";
  } catch {
    return null;
  }
}

/**
 * Pins that only assert PRESENCE. `latest` is deliberately not one of them any more: it reads
 * as a promise of currency, and for six majors it meant "answered --version" (#500). A repo that
 * genuinely wants "whatever is installed" now says so with a pin that does not promise more.
 */
const PRESENCE_PINS = new Set(["any", "present", "*"]);

export function isPresencePin(required: string): boolean {
  return PRESENCE_PINS.has(required.trim().toLowerCase());
}

/**
 * Does the installed version satisfy the pin's MATCHING requirement?
 *
 * `latest` and the presence pins have nothing to match, so they are satisfied by existing —
 * currency is reported separately (`ToolStatus.currency`) rather than folded in here, because
 * an outdated tool is a warning and a missing one is a failure, and collapsing them is what
 * made drift invisible.
 */
function versionSatisfies(installed: string, required: string): boolean {
  if (required === "latest" || isPresencePin(required)) return true;
  // Simple prefix match: required "22" matches "22.x.x", required "2.78" matches "2.78.x"
  return installed.startsWith(required);
}

export async function checkTools(
  tools: ToolConfig,
  resolve: ToolResolver = resolveToolBin,
  currency?: CurrencyChecker,
): Promise<ToolStatus[]> {
  const results: ToolStatus[] = [];

  for (const [name, required] of Object.entries(tools)) {
    const installed = await getToolVersion(name, resolve);
    const ok = installed !== null && versionSatisfies(installed, required);
    // The executable, not the declaration: `aqua:aquasecurity/trivy` resolves as `trivy`.
    const path = (await resolve(probeName(name))) ?? undefined;
    const source = path ? classifyToolPath(path, { home: homedir() }).source : undefined;
    // Only a pin that PROMISES currency pays for a lookup. An exact pin says nothing about
    // being newest, and asking anyway would put the network on the gate's critical path.
    const drift =
      currency && required === "latest"
        ? await currency(name, source ?? "unknown", installed)
        : undefined;
    results.push({ name, required, installed, ok, path, source, currency: drift });
  }

  return results;
}
