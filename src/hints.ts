/**
 * kit hints — a tiny DETERMINISTIC "smart-feeling" tip engine (zero LLM).
 *
 * kit already ships many opt-in capabilities (signed policy, audit anchoring,
 * container/IaC scanning, malware heuristics) — but a user only finds them by
 * reading source. This surfaces them at the right MOMENT via plain state checks:
 * "you have a Dockerfile but trivy isn't installed", "your policy is unsigned",
 * "your audit log was never anchored". No model, no telemetry — just IF state →
 * THEN one short, actionable tip.
 *
 * Each rule is shown AT MOST ONCE (a 0600 marker under ~/.kit suppresses it
 * thereafter) so hints teach without nagging. `KIT_NO_HINTS=1` silences them all.
 * Every detector is fail-safe: a thrown error means "don't hint", never a crash —
 * a tip must never break `kit check` or a session.
 */
import { existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { getMemoryDir } from "./memory/db.js";
import { resolveToolBin } from "./utils/resolveTool.js";
import { loadPolicy, verifyPolicy } from "./policy-doc.js";
import { tryLoadIdentity } from "./identity.js";
import { readAnchorRecord } from "./audit-anchor.js";
import { loadConfig } from "./config.js";

export interface Hint {
  id: string;
  tip: string;
}

interface HintRule {
  id: string;
  /** The actionable one-liner (no leading icon — the caller adds the prefix). */
  tip: string;
  /** True ⇒ this rule's state holds for `root` right now. Must be fail-safe. */
  detect: (root: string) => Promise<boolean> | boolean;
}

function isOff(): boolean {
  return ["1", "true", "yes"].includes((process.env.KIT_NO_HINTS ?? "").trim().toLowerCase());
}

function markerPath(id: string): string {
  return join(getMemoryDir(), `.hint-${id}`);
}

function alreadyShown(id: string): boolean {
  try {
    return existsSync(markerPath(id));
  } catch {
    return false;
  }
}

function markShown(id: string): void {
  try {
    mkdirSync(getMemoryDir(), { recursive: true, mode: 0o700 });
    writeFileSync(markerPath(id), "", { mode: 0o600 });
  } catch {
    // best-effort — worst case the hint shows once more
  }
}

function hasAny(root: string, names: string[]): boolean {
  return names.some((n) => {
    try {
      return existsSync(resolve(root, n));
    } catch {
      return false;
    }
  });
}

async function guarddogEnabled(root: string): Promise<boolean> {
  if (["1", "true", "yes"].includes((process.env.KIT_GUARDDOG ?? "").trim().toLowerCase()))
    return true;
  try {
    const cfg = await loadConfig(resolve(root, ".kit.toml"));
    return (cfg as { scan?: { guarddog?: boolean } })?.scan?.guarddog === true;
  } catch {
    return false;
  }
}

/**
 * Ordered by priority (a single surfacing shows the first applicable, un-shown
 * rule). All conditions are deterministic file/tool/config state.
 */
const RULES: HintRule[] = [
  {
    id: "audit-unanchored",
    tip: "your audit log isn't anchored — run `kit audit anchor` for tamper-detection (one-time)",
    detect: async (root) => {
      const logPath = resolve(root, ".kit-audit.jsonl");
      if (!existsSync(logPath) || statSync(logPath).size === 0) return false;
      return (await readAnchorRecord(logPath)) === null;
    },
  },
  {
    id: "policy-unsigned",
    tip: "your `.kit-policy.toml` is unsigned — run `kit policy sign` to attribute it to your identity",
    detect: (root) => loadPolicy(root) !== null && verifyPolicy(root).status === "unsigned",
  },
  {
    id: "trivy-missing",
    tip: "you have a Dockerfile/Compose but trivy isn't installed — `mise use aqua:aquasecurity/trivy` to scan containers + IaC",
    detect: async (root) =>
      hasAny(root, ["Dockerfile", "docker-compose.yml", "compose.yaml", "compose.yml"]) &&
      !(await resolveToolBin("trivy")),
  },
  {
    id: "guarddog-off",
    tip: "malware heuristics are off — set `[scan] guarddog = true` in .kit.toml (or KIT_GUARDDOG=1) to enable GuardDog",
    detect: async (root) =>
      hasAny(root, ["package.json", "requirements.txt", "pyproject.toml"]) &&
      !(await guarddogEnabled(root)) &&
      !!(await resolveToolBin("semgrep")), // only suggest when it can actually run
  },
  {
    id: "policy-init",
    tip: "you have a kit identity but no org policy — `kit policy init` to define signed, distributable rules",
    detect: (root) => tryLoadIdentity() !== null && loadPolicy(root) === null,
  },
];

/**
 * Collect up to `max` (default 1) applicable, not-yet-shown hints for `root`.
 * Marks the returned hints as shown unless `markSeen: false`. Returns [] when
 * `KIT_NO_HINTS` is set. Never throws.
 */
export async function collectHints(
  root: string,
  opts: { max?: number; markSeen?: boolean } = {},
): Promise<Hint[]> {
  if (isOff()) return [];
  const max = opts.max ?? 1;
  const markSeen = opts.markSeen ?? true;
  const out: Hint[] = [];
  for (const rule of RULES) {
    if (out.length >= max) break;
    if (alreadyShown(rule.id)) continue;
    let hit: boolean;
    try {
      hit = await rule.detect(root);
    } catch {
      hit = false; // a detector must never break the caller
    }
    if (!hit) continue;
    if (markSeen) markShown(rule.id);
    out.push({ id: rule.id, tip: rule.tip });
  }
  return out;
}
