import { createHash } from "node:crypto";
import type { SecurityCheckResult } from "../check-security.js";

type Severity = NonNullable<SecurityCheckResult["severity"]>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface SarifLocation {
  physicalLocation?: { artifactLocation?: { uri?: string }; region?: { startLine?: number } };
}
export interface SarifResult {
  ruleId?: string;
  /** SARIF 2.1.0 kind. An absent kind represents a failure. */
  kind?: string;
  level?: string;
  message?: { text?: string };
  locations?: SarifLocation[];
  properties?: { "security-severity"?: string };
  fingerprints?: unknown;
  partialFingerprints?: unknown;
}

export function sarifLocation(res: SarifResult): string {
  const { artifactLocation, region } = res.locations?.[0]?.physicalLocation ?? {};
  const uri = artifactLocation?.uri;
  return uri ? ` (${uri}${region?.startLine ? `:${region.startLine}` : ""})` : "";
}

/** A SARIF finding keeps the identity the scanner gave it and how many results carried it. */
export type SarifFinding = SecurityCheckResult & { fingerprint: string; occurrences: number };

/** `name=value` pairs of a SARIF fingerprint map, in key order; non-string values are ignored. */
function fingerprintPairs(map: unknown): string | undefined {
  if (!isRecord(map)) return undefined;
  const pairs = Object.keys(map)
    .sort()
    .filter((key) => typeof map[key] === "string" && map[key] !== "")
    .map((key) => `${key}=${String(map[key])}`);
  return pairs.length > 0 ? pairs.join(";") : undefined;
}

/**
 * The result's identity: SARIF `fingerprints`, else `partialFingerprints`, else rule, location and
 * message. The message stays in the fallback so two different findings a scanner reports at one
 * line (two packages in one lockfile) are not merged; that fallback is hashed, not shown.
 */
export function sarifFingerprint(res: SarifResult): string {
  const full = fingerprintPairs(res.fingerprints);
  if (full) return `fingerprints:${full}`;
  const partial = fingerprintPairs(res.partialFingerprints);
  if (partial) return `partialFingerprints:${partial}`;
  const { artifactLocation, region } = res.locations?.[0]?.physicalLocation ?? {};
  const where = `${artifactLocation?.uri ?? ""}:${region?.startLine ?? ""}`;
  const fallback = JSON.stringify([res.ruleId ?? "", where, res.message?.text ?? ""]);
  return `location:${createHash("sha256").update(fallback).digest("hex").slice(0, 16)}`;
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 3, high: 2, medium: 1, low: 0 };

/**
 * One finding per tool, rule and fingerprint, in first-seen order. A scanner that reports one result four
 * times yields one finding with `occurrences: 4` and the highest severity any copy had.
 */
export function collapseDuplicates(findings: SarifFinding[]): SarifFinding[] {
  const byKey = new Map<string, SarifFinding>();
  for (const finding of findings) {
    const key = JSON.stringify([finding.name, finding.fingerprint]);
    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, finding);
      continue;
    }
    seen.occurrences += finding.occurrences;
    const worse = SEVERITY_RANK[finding.severity ?? "low"] > SEVERITY_RANK[seen.severity ?? "low"];
    if (worse) seen.severity = finding.severity;
  }
  return [...byKey.values()];
}
