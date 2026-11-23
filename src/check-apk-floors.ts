/**
 * `kit check` security result: are the `apk add` floors in the repository's Dockerfiles at or
 * above every version in which Alpine fixed a CVE? Reads Alpine's public security database
 * (secdb.alpinelinux.org) and both repository indexes (dl-cdn.alpinelinux.org, to map a subpackage
 * such as `libexpat` to its origin `expat`). Fixed hosts only, no redirects, bounded size. Air-gap
 * mode skips it and says so; an unreachable source is a check that did not run, never a pass.
 */
import { isUtf8 } from "node:buffer";
import { join } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";
import {
  judgeFloors,
  parseApkFloors,
  type ApkFloor,
  type FloorFinding,
} from "./dockerfile-apk-floors.js";
import { discoverDockerfiles, type DockerfileInventoryGap } from "./image-scan.js";
import { isAirGap } from "./scanners.js";
import { defaultApkFetcher, type ApkFetcher } from "./check-apk-fetch.js";
import {
  aggregateAlpineStatus,
  alpineSourceFailure,
  readAlpineBranch,
  readNewestStableBranch,
  type AlpineSourceEvidence,
} from "./check-apk-sources.js";
import { sanitizeDisplayText } from "./display-text.js";
import { readRegularFileBytesIfPresent } from "./upstream-safe-read.js";
import type { ApkIndexKeys } from "./alpine-index-signature.js";
export { defaultApkFetcher, type ApkFetcher } from "./check-apk-fetch.js";

export const APK_FLOORS_NAME = "alpine apk floors";

interface FloorInventory {
  floors: ApkFloor[];
  files: string[];
  unread: string[];
  gaps: DockerfileInventoryGap[];
}

type FloorComparison = ReturnType<typeof judgeFloors> & {
  failures: string[];
  evidenceSources: AlpineSourceEvidence[];
  checked: string[];
  partialSources: string[];
  preliminary: FloorFinding[];
};

const result = (r: Omit<SecurityCheckResult, "category" | "name">): SecurityCheckResult => ({
  category: "supply-chain",
  name: APK_FLOORS_NAME,
  ...r,
});

/** Read the Dockerfiles in scope and retain discovery and file failures. */
function readFloors(root: string): FloorInventory {
  const inventory = discoverDockerfiles(root);
  const result: FloorInventory = { floors: [], files: [], unread: [], gaps: inventory.gaps };
  for (const rel of inventory.files) {
    try {
      const bytes = readRegularFileBytesIfPresent(join(root, rel));
      if (!bytes || !isUtf8(bytes)) {
        result.unread.push(rel);
        continue;
      }
      const floors = parseApkFloors(bytes.toString("utf8"));
      if (floors.length) result.files.push(rel);
      for (const floor of floors) result.floors.push(floor);
    } catch {
      result.unread.push(rel);
    }
  }
  return result;
}

function describe(findings: FloorFinding[]): string {
  return findings
    .map((f) => {
      const cves =
        f.cves.slice(0, 4).map(sanitizeDisplayText).join(", ") +
        (f.cves.length > 4 ? `, +${f.cves.length - 4}` : "");
      return `${f.name}>=${f.floor} admits versions fixed in ${f.fixedIn} on ${f.branch} (${cves})`;
    })
    .join("; ");
}

/** Floors grouped by the branch they are judged on; `assumed` is the newest stable branch, when used. */
async function groupByBranch(floors: ApkFloor[], fetcher: ApkFetcher) {
  let assumed: string | null = null;
  const byBranch = new Map<string, ApkFloor[]>();
  const latest: ApkFloor[] = [];
  for (const floor of floors) {
    if (floor.branch.kind === "branch") {
      const list = byBranch.get(floor.branch.branch) ?? [];
      list.push(floor);
      byBranch.set(floor.branch.branch, list);
    } else latest.push(floor);
  }
  const lookup = latest.length ? await readNewestStableBranch(fetcher) : undefined;
  if (lookup && "data" in lookup) {
    assumed = lookup.data;
    byBranch.set(assumed, [...(byBranch.get(assumed) ?? []), ...latest]);
  }
  return { byBranch, assumed, lookup: lookup?.evidence };
}

async function compareBranches(
  byBranch: ReadonlyMap<string, ApkFloor[]>,
  lookup: AlpineSourceEvidence | undefined,
  fetcher: ApkFetcher,
  keys?: ApkIndexKeys,
): Promise<FloorComparison> {
  const judged: FloorComparison = {
    findings: [],
    unparsed: [],
    unresolved: [],
    failures: lookup && "reason" in lookup ? [lookup.reason] : [],
    evidenceSources: lookup ? [lookup] : [],
    checked: [],
    partialSources: [],
    preliminary: [],
  };
  for (const [branch, list] of [...byBranch].sort()) {
    try {
      const sources = await readAlpineBranch(branch, fetcher, keys);
      judged.evidenceSources.push(...sources.sources);
      const one = judgeFloors(list, branch, sources.secfixes, sources.origins);
      const findings = sources.originsComplete ? judged.findings : judged.preliminary;
      for (const finding of one.findings) findings.push(finding);
      for (const version of one.unparsed) judged.unparsed.push(version);
      for (const name of one.unresolved) judged.unresolved.push(name);
      if (sources.failures.length) {
        judged.failures.push(...sources.failures);
        judged.partialSources.push(...sources.checked);
      } else judged.checked.push(branch);
    } catch (error) {
      judged.failures.push(alpineSourceFailure(error, branch));
    }
  }
  return judged;
}

/** The coverage note of a verdict: what was checked, what was assumed, and what was not compared. */
function coverageNote(
  judged: FloorComparison,
  assumed: string | null,
  inventory: FloorInventory,
  incomplete: boolean,
): string {
  const { unparsed, unresolved, failures, checked, partialSources, preliminary } = judged;
  const notes: string[] = [];
  if (checked.length)
    notes.push(
      `checked on ${checked.join(", ")} against secdb main+community and APKINDEX main+community (x86_64)`,
    );
  if (assumed)
    notes.push(
      `the base image tag names no Alpine branch, so ${assumed} (newest stable) was assumed`,
    );
  if (unparsed.length) notes.push(`not compared, version not parsed: ${unparsed.join(", ")}`);
  if (unresolved.length) notes.push(`not compared, origin unresolved: ${unresolved.join(", ")}`);
  if (partialSources.length) notes.push(`validated sources: ${partialSources.join(", ")}`);
  if (preliminary.length)
    notes.push(`preliminary findings with incomplete origin data: ${describe(preliminary)}`);
  if (failures.length) notes.push(`source errors (unverified): ${failures.join("; ")}`);
  notes.push(...inventoryNotes(inventory));
  if (incomplete) notes.push("incomplete comparison remains unverified");
  return notes.length ? ` Note: ${notes.join("; ")}.` : "";
}

function inventoryNotes(inventory: FloorInventory): string[] {
  const notes: string[] = [];
  if (inventory.unread.length)
    notes.push(`Dockerfile not read: ${inventory.unread.map(sanitizeDisplayText).join(", ")}`);
  if (inventory.gaps.length) {
    const entries = inventory.gaps
      .slice(0, 8)
      .map(({ path, reason }) => `${sanitizeDisplayText(path)} (${reason})`);
    const extra = inventory.gaps.length - entries.length;
    notes.push(
      `Dockerfile discovery incomplete: ${entries.join(", ")}${extra > 0 ? `, +${extra} more` : ""}`,
    );
  }
  return notes;
}

function verdict(
  inventory: FloorInventory,
  judged: FloorComparison,
  assumed: string | null,
): SecurityCheckResult {
  const { findings, unparsed, unresolved, failures } = judged;
  const { floors, files, unread, gaps } = inventory;
  const incomplete =
    unparsed.length > 0 ||
    unresolved.length > 0 ||
    failures.length > 0 ||
    unread.length > 0 ||
    gaps.length > 0;
  const tail = coverageNote(judged, assumed, inventory, incomplete);
  const locations = [...files, ...unread].map(sanitizeDisplayText).join(", ") || "the project";
  const evidence = {
    evidenceStatus: aggregateAlpineStatus(judged.evidenceSources, incomplete, findings.length > 0),
    evidenceSources: judged.evidenceSources,
  };
  if (findings.length === 0)
    return result({
      ...evidence,
      status: incomplete ? "warn" : "pass",
      ...(incomplete
        ? { severity: "medium" as const, didNotRun: true, scanIncomplete: true as const }
        : {}),
      detail: incomplete
        ? `apk floor comparison in ${locations} is unverified.${tail}`
        : `${floors.length} apk floor(s) in ${locations} are at or above every Alpine secdb fix.${tail}`,
    });
  return result({
    ...evidence,
    status: "warn",
    severity: "high",
    ...(incomplete
      ? { didNotRun: true, hasFindings: true as const, scanIncomplete: true as const }
      : {}),
    files,
    detail: `${findings.length} apk floor(s) below an Alpine security fix: ${describe(findings)}. A floor that still matches a cached build layer keeps the vulnerable version.${tail}`,
    suggestion: `raise each floor to the fixed version, e.g. '${findings[0].name}>=${findings[0].fixedIn}'`,
  });
}

export async function checkApkFloors(
  root: string,
  fetcher: ApkFetcher = defaultApkFetcher,
  env: NodeJS.ProcessEnv = process.env,
  keys?: ApkIndexKeys,
): Promise<SecurityCheckResult> {
  const inventory = readFloors(root);
  const { floors, unread, gaps } = inventory;
  if (floors.length === 0 && unread.length === 0 && gaps.length === 0)
    return result({ status: "skip", detail: "no apk add version floors in a Dockerfile" });
  if (isAirGap(env)) {
    const notes = inventoryNotes(inventory);
    const detail = `air-gap mode: ${floors.length} apk floor(s) not compared with Alpine secdb (unverified)`;
    if (notes.length === 0)
      return result({ status: "skip", detail, evidenceStatus: "unavailable" });
    return result({
      status: "warn",
      severity: "medium",
      didNotRun: true,
      scanIncomplete: true,
      evidenceStatus: "partial",
      detail: [detail, ...notes].join(". "),
    });
  }
  const { byBranch, assumed, lookup } = await groupByBranch(floors, fetcher);
  const judged = await compareBranches(byBranch, lookup, fetcher, keys);
  return verdict(inventory, judged, assumed);
}
