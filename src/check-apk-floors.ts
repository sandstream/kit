/**
 * `kit check` security result: are the `apk add` floors in the repository's Dockerfiles at or
 * above every version in which Alpine fixed a CVE? Reads Alpine's public security database
 * (secdb.alpinelinux.org) and both repository indexes (dl-cdn.alpinelinux.org, to map a subpackage
 * such as `libexpat` to its origin `expat`). Fixed hosts only, no redirects, bounded size. Air-gap
 * mode skips it and says so; an unreachable source is a check that did not run, never a pass.
 */
import { readFileSync } from "node:fs";
import { isUtf8 } from "node:buffer";
import { join } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";
import {
  apkIndexText,
  judgeFloors,
  newestStableBranch,
  parseApkFloors,
  parseApkIndexOrigins,
  parseSecdb,
  type ApkFloor,
  type FloorFinding,
} from "./dockerfile-apk-floors.js";
import { findDockerfiles } from "./image-scan.js";
import { isAirGap } from "./scanners.js";
import { defaultApkFetcher, type ApkFetcher } from "./check-apk-fetch.js";
import { mergeApkIndexOrigins } from "./alpine-index-origins.js";
export { defaultApkFetcher, type ApkFetcher } from "./check-apk-fetch.js";

export const APK_FLOORS_NAME = "alpine apk floors";
const SECDB = "https://secdb.alpinelinux.org";
const CDN = "https://dl-cdn.alpinelinux.org/alpine";

type FloorComparison = ReturnType<typeof judgeFloors> & {
  failures: string[];
  /** Dockerfiles whose floors were not read, so their floors were never compared. */
  unread: string[];
  /** Branches whose four sources were read and compared in full. */
  checked: string[];
};

const result = (r: Omit<SecurityCheckResult, "category" | "name">): SecurityCheckResult => ({
  category: "supply-chain",
  name: APK_FLOORS_NAME,
  ...r,
});

/** The floors of every Dockerfile; `unread` lists the files whose floors could not be read. */
function readFloors(root: string): { floors: ApkFloor[]; files: string[]; unread: string[] } {
  const floors: ApkFloor[] = [];
  const files: string[] = [];
  const unread: string[] = [];
  for (const rel of findDockerfiles(root)) {
    let text: string;
    try {
      text = readFileSync(join(root, rel), "utf8");
    } catch {
      unread.push(rel);
      continue;
    }
    const found = parseApkFloors(text);
    if (found.length) files.push(rel);
    floors.push(...found);
  }
  return { floors, files, unread };
}

async function judgeBranch(
  branch: string,
  floors: ApkFloor[],
  fetcher: ApkFetcher,
): Promise<ReturnType<typeof judgeFloors>> {
  const [main, community, mainIndex, communityIndex] = await Promise.all([
    fetcher(`${SECDB}/${branch}/main.json`),
    fetcher(`${SECDB}/${branch}/community.json`),
    fetcher(`${CDN}/${branch}/main/x86_64/APKINDEX.tar.gz`),
    fetcher(`${CDN}/${branch}/community/x86_64/APKINDEX.tar.gz`),
  ]);
  const secfixes = combineSecdb([main, community]);
  const origins = mergeApkIndexOrigins(
    [mainIndex, communityIndex].map((index) => parseApkIndexOrigins(apkIndexText(index))),
  );
  return judgeFloors(floors, branch, secfixes, origins);
}

function combineSecdb(sources: Buffer[]): Map<string, Map<string, string[]>> {
  const combined = new Map<string, Map<string, string[]>>();
  for (const source of sources) {
    if (!isUtf8(source)) throw new Error("secdb: invalid UTF-8");
    for (const [name, fixes] of parseSecdb(JSON.parse(source.toString("utf8")))) {
      const target = combined.get(name) ?? new Map<string, string[]>();
      for (const [version, ids] of fixes)
        target.set(version, [...new Set([...(target.get(version) ?? []), ...ids])]);
      combined.set(name, target);
    }
  }
  return combined;
}

function describe(findings: FloorFinding[]): string {
  return findings
    .map((f) => {
      const cves =
        f.cves.slice(0, 4).join(", ") + (f.cves.length > 4 ? `, +${f.cves.length - 4}` : "");
      return `${f.name}>=${f.floor} admits versions fixed in ${f.fixedIn} on ${f.branch} (${cves})`;
    })
    .join("; ");
}

function sourceFailure(error: unknown, context: string): string {
  return `${error instanceof Error ? error.message : String(error)} (${context})`;
}

/** Floors grouped by the branch they are judged on; `assumed` is the newest stable branch, when used. */
async function groupByBranch(
  floors: ApkFloor[],
  fetcher: ApkFetcher,
): Promise<{ byBranch: Map<string, ApkFloor[]>; assumed: string | null; failures: string[] }> {
  let assumed: string | null = null;
  const byBranch = new Map<string, ApkFloor[]>();
  const latest: ApkFloor[] = [];
  const failures: string[] = [];
  for (const floor of floors) {
    if (floor.branch.kind === "branch") {
      const list = byBranch.get(floor.branch.branch) ?? [];
      list.push(floor);
      byBranch.set(floor.branch.branch, list);
    } else latest.push(floor);
  }
  if (latest.length > 0) {
    try {
      assumed = newestStableBranch((await fetcher(`${SECDB}/`)).toString("utf8"));
      if (!assumed) throw new Error("secdb index lists no stable branch");
      byBranch.set(assumed, [...(byBranch.get(assumed) ?? []), ...latest]);
    } catch (error) {
      failures.push(sourceFailure(error, "latest Alpine branch"));
    }
  }
  return { byBranch, assumed, failures };
}

async function compareBranches(
  byBranch: ReadonlyMap<string, ApkFloor[]>,
  failures: string[],
  unread: string[],
  fetcher: ApkFetcher,
): Promise<FloorComparison> {
  const judged: FloorComparison = {
    findings: [],
    unparsed: [],
    unresolved: [],
    failures: [...failures],
    unread: [...unread],
    checked: [],
  };
  for (const [branch, list] of [...byBranch].sort()) {
    try {
      const one = await judgeBranch(branch, list, fetcher);
      judged.findings.push(...one.findings);
      judged.unparsed.push(...one.unparsed);
      judged.unresolved.push(...one.unresolved);
      judged.checked.push(branch);
    } catch (error) {
      judged.failures.push(sourceFailure(error, branch));
    }
  }
  return judged;
}

/** The coverage note of a verdict: what was checked, what was assumed, and what was not compared. */
function coverageNote(
  judged: FloorComparison,
  assumed: string | null,
  incomplete: boolean,
): string {
  const { unparsed, unresolved, failures, unread, checked } = judged;
  const notes: string[] = [];
  if (checked.length)
    notes.push(
      `checked on ${checked.join(", ")} against secdb main+community and APKINDEX main+community`,
    );
  if (assumed)
    notes.push(
      `the base image tag names no Alpine branch, so ${assumed} (newest stable) was assumed`,
    );
  if (unparsed.length) notes.push(`not compared, version not parsed: ${unparsed.join(", ")}`);
  if (unresolved.length) notes.push(`not compared, origin unresolved: ${unresolved.join(", ")}`);
  if (failures.length) notes.push(`source errors (unverified): ${failures.join("; ")}`);
  if (unread.length) notes.push(`Dockerfile not read: ${unread.join(", ")}`);
  if (incomplete) notes.push("incomplete comparison remains unverified");
  return notes.length ? ` Note: ${notes.join("; ")}.` : "";
}

function verdict(
  floors: ApkFloor[],
  files: string[],
  judged: FloorComparison,
  assumed: string | null,
): SecurityCheckResult {
  const { findings, unparsed, unresolved, failures, unread } = judged;
  const incomplete =
    unparsed.length > 0 || unresolved.length > 0 || failures.length > 0 || unread.length > 0;
  const tail = coverageNote(judged, assumed, incomplete);
  if (findings.length === 0)
    return result({
      status: incomplete ? "warn" : "pass",
      ...(incomplete ? { severity: "medium" as const, didNotRun: true } : {}),
      detail: incomplete
        ? `apk floor comparison in ${[...files, ...unread].join(", ")} is unverified.${tail}`
        : `${floors.length} apk floor(s) in ${files.join(", ")} are at or above every Alpine secdb fix.${tail}`,
    });
  return result({
    status: "warn",
    severity: "high",
    ...(incomplete ? { didNotRun: true } : {}),
    files,
    detail: `${findings.length} apk floor(s) below an Alpine security fix: ${describe(findings)}. A floor that still matches a cached build layer keeps the vulnerable version.${tail}`,
    suggestion: `raise each floor to the fixed version, e.g. '${findings[0].name}>=${findings[0].fixedIn}'`,
  });
}

export async function checkApkFloors(
  root: string,
  fetcher: ApkFetcher = defaultApkFetcher,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SecurityCheckResult> {
  const { floors, files, unread } = readFloors(root);
  if (floors.length === 0 && unread.length === 0)
    return result({ status: "skip", detail: "no apk add version floors in a Dockerfile" });
  if (isAirGap(env))
    return result({
      status: "skip",
      detail: `air-gap mode: ${floors.length} apk floor(s) not compared with Alpine secdb (unverified)`,
    });
  const { byBranch, assumed, failures } = await groupByBranch(floors, fetcher);
  const judged = await compareBranches(byBranch, failures, unread, fetcher);
  return verdict(floors, files, judged, assumed);
}
