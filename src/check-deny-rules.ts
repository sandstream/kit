/**
 * The `deny rule liveness` row of `kit check`: are kit's Claude Code deny rules still where
 * `kit agent-config` wrote them?
 *
 * `kit agent-config` writes twelve deny rules (`KIT_DENY_RULES`: credential directories, `.env*`
 * with the `.env.example` carve-out, force push, `git reset --hard`) into the project
 * `.claude/settings.json`; `--user` writes no deny rule. kit-research
 * `prismor-always-allowed-rules-vs-kit` deleted five of them and added three allows to
 * `.claude/settings.local.json`, and no `kit check` row changed. `enforcement gate liveness`
 * checks the hooks only.
 *
 * - **Applies** where kit set this checkout up: the gate marker `kit agent-config` leaves in
 *   `.claude/` is present, or `.claude/settings.json` holds any kit deny rule. Otherwise it skips,
 *   so a fresh clone or CI is not failed for a file that is gitignored.
 * - **Fails** when a kit deny rule is missing from `.claude/settings.json` (all of them count:
 *   fail closed, the set is fixed), or when that file no longer parses. The detail names each
 *   missing rule and the repair: `kit agent-config` appends the missing ones and keeps the rest.
 * - **Overriding allows:** Claude Code applies deny rules before allow rules, so an allow in
 *   `.claude/settings.local.json` that matches a kit deny rule takes effect only once that deny
 *   rule is gone. Such an allow is named in the failure when its deny rule is missing, and named in
 *   the passing detail otherwise, so the next removal is not a surprise.
 *
 * Read-only and deterministic. It reads two files and never runs anything they name.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { KIT_DENY_RULES } from "./agent-config-strict.js";
import type { SecurityCheckResult } from "./check-security.js";
import {
  allowsOverridingKitDeny,
  heldKitDenyRules,
  missingKitDenyRules,
  permissionListsOf,
  type DenyOverride,
} from "./kit-deny-rules.js";

const NAME = "deny rule liveness";
const SETTINGS = ".claude/settings.json";
const LOCAL = ".claude/settings.local.json";
const REPAIR = "Run: kit agent-config (it appends the missing deny rules and keeps the rest)";

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function overridesIn(root: string): DenyOverride[] {
  const local = readOrNull(resolve(root, LOCAL));
  const lists = local === null ? null : permissionListsOf(local);
  return lists ? allowsOverridingKitDeny(lists.allow) : [];
}

function describeOverrides(overrides: DenyOverride[]): string {
  const allows = [...new Set(overrides.map((o) => o.allow))];
  return allows.join(", ");
}

const fail = (detail: string): SecurityCheckResult => ({
  category: "exposure",
  name: NAME,
  status: "fail",
  severity: "high",
  detail,
  suggestion: REPAIR,
});

/** The row. `cwd` is the governed root; the gate marker path comes from agent-config. */
export async function checkKitDenyRules(cwd: string = process.cwd()): Promise<SecurityCheckResult> {
  const text = readOrNull(resolve(cwd, SETTINGS));
  const lists = text === null ? null : permissionListsOf(text);
  const { gateMarkerPath } = await import("./agent-config.js");
  const setUp = existsSync(gateMarkerPath(cwd)) || heldKitDenyRules(lists?.deny ?? []).length > 0;
  if (!setUp) {
    const detail = "kit agent-config has not written deny rules in this checkout";
    return { category: "exposure", name: NAME, status: "skip", detail };
  }
  if (text !== null && lists === null) {
    return fail(`${SETTINGS} does not parse as a JSON object, so none of kit's deny rules apply`);
  }
  const missing = missingKitDenyRules(lists?.deny ?? []);
  const overrides = overridesIn(cwd);
  const live = overrides.filter((o) => missing.includes(o.deny));
  if (missing.length > 0) {
    const allowed = live.length > 0 ? `; ${LOCAL} allows ${describeOverrides(live)}` : "";
    return fail(
      `${missing.length} of kit's deny rule(s) missing from ${SETTINGS}: ${missing.join(", ")}${allowed}`,
    );
  }
  const inert =
    overrides.length > 0
      ? `; ${LOCAL} allows ${describeOverrides(overrides)}, inert while the deny rules stay`
      : "";
  return {
    category: "exposure",
    name: NAME,
    status: "pass",
    detail: `all ${KIT_DENY_RULES.length} kit deny rules present in ${SETTINGS}${inert}`,
  };
}
