import { stripVTControlCharacters } from "node:util";
import type { Advisory, AuditOutcome, Severity } from "./advisory-baseline.js";
import {
  reportText,
  scannerObject,
  scannerRecord,
  type ScannerEvidenceStatus,
} from "./check-scanner-evidence.js";

const PACKAGE = /^(?:@[\w.~-]+\/)?[\w.~-]+$/;
const GHSA =
  /^https:\/\/github\.com\/advisories\/(GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4})(?:[/?#]|$)/i;
const SEVERITIES: readonly Severity[] = ["info", "low", "moderate", "high", "critical"];
const BANNER = /^bun audit v\d+\.\d+\.\d+(?:[-+][\w.-]+)?(?: \([a-f0-9]{7,40}\))?$/i;

function severityOf(value: unknown): Severity | undefined {
  return SEVERITIES.find((severity) => severity === value);
}

function readAdvisory(value: unknown, name: string): Advisory | undefined {
  if (!scannerRecord(value) || !reportText(value.url) || !reportText(value.vulnerable_versions))
    return undefined;
  const id = GHSA.exec(value.url)?.[1]?.toUpperCase();
  const severity = severityOf(value.severity);
  if (!id || !severity) return undefined;
  const title = typeof value.title === "string" ? value.title.replace(/[\x00-\x1f\x7f]/g, " ") : "";
  return { id, package: name, severity, title };
}

function readMap(doc: Record<string, unknown>, expected?: ReadonlySet<string>) {
  let complete = true;
  const advisories = new Map<string, Advisory>();
  for (const [name, rows] of Object.entries(doc)) {
    if (!PACKAGE.test(name) || !Array.isArray(rows)) {
      complete = false;
      continue;
    }
    if (expected && !expected.has(name)) {
      complete = false;
      continue;
    }
    for (const row of rows) {
      const advisory = readAdvisory(row, name);
      if (!advisory) {
        complete = false;
        continue;
      }
      const previous = advisories.get(advisory.id);
      if (
        !previous ||
        SEVERITIES.indexOf(previous.severity) < SEVERITIES.indexOf(advisory.severity)
      )
        advisories.set(advisory.id, advisory);
    }
  }
  return {
    complete,
    advisories: [...advisories.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function failed(
  advisories: Advisory[],
  evidenceStatus: ScannerEvidenceStatus,
  error: string,
): Omit<AuditOutcome, "manager"> {
  return { advisories, evidenceStatus, error };
}

/** Bun prints a raw registry advisory map. Some releases print a banner before any diagnostics. */
export function readBunAuditEvidence(
  input: { stdout: string; stderr: string; exitCode: number | null; error?: string },
  expected?: ReadonlySet<string>,
): Omit<AuditOutcome, "manager"> {
  const doc = scannerObject(input.stdout);
  const { complete, advisories } = doc
    ? readMap(doc, expected)
    : { complete: false, advisories: [] };
  const unverified = advisories.length > 0 ? "partial" : "unavailable";
  if (input.error || input.exitCode === null)
    return failed(advisories, unverified, "Bun audit did not complete");
  const diagnostic = stripVTControlCharacters(input.stderr)
    .split(/\r?\n/)
    .some((line) => line.trim() !== "" && !BANNER.test(line.trim()));
  if (diagnostic)
    return failed(advisories, unverified, "Bun audit reported a registry or coverage diagnostic");
  if (!doc || !complete) {
    return failed(
      advisories,
      advisories.length ? "partial" : input.stdout.trim() ? "malformed" : "missing",
      "Bun audit did not return a complete advisory map for the lockfile",
    );
  }
  if (input.exitCode !== (advisories.length > 0 ? 1 : 0))
    return failed(advisories, unverified, "Bun audit exit status disagrees with the advisory map");
  if (!expected) return failed(advisories, "unsupported", "Bun audit scope was not verified");
  return { advisories, evidenceStatus: advisories.length ? "complete" : "complete-empty" };
}
