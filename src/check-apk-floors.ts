/**
 * `kit check` security result: are the `apk add` floors in the repository's Dockerfiles at or
 * above every version in which Alpine fixed a CVE? Reads Alpine's public security database
 * (secdb.alpinelinux.org) and the main APKINDEX (dl-cdn.alpinelinux.org, to map a subpackage
 * such as `libexpat` to its origin `expat`). Fixed hosts only, no redirects, bounded size. Air-gap
 * mode skips it and says so; an unreachable source is a check that did not run, never a pass.
 */
import { readFileSync } from "node:fs";
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

export const APK_FLOORS_NAME = "alpine apk floors";
const SECDB = "https://secdb.alpinelinux.org";
const CDN = "https://dl-cdn.alpinelinux.org/alpine";
const MAX_BYTES = 16 * 1024 * 1024;

/** Fetch one URL as bytes; throws on any failure. Injected in tests, so they never open a socket. */
export type ApkFetcher = (url: string) => Promise<Buffer>;

export const defaultApkFetcher: ApkFetcher = async (url) => {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_BYTES) throw new Error(`${url} is over ${MAX_BYTES} bytes`);
  return body;
};

const result = (r: Omit<SecurityCheckResult, "category" | "name">): SecurityCheckResult => ({
  category: "supply-chain",
  name: APK_FLOORS_NAME,
  ...r,
});

function readFloors(root: string): { floors: ApkFloor[]; files: string[] } {
  const floors: ApkFloor[] = [];
  const files: string[] = [];
  for (const rel of findDockerfiles(root)) {
    let text: string;
    try {
      text = readFileSync(join(root, rel), "utf8");
    } catch {
      continue;
    }
    const found = parseApkFloors(text);
    if (found.length) files.push(rel);
    floors.push(...found);
  }
  return { floors, files };
}

async function judgeBranch(
  branch: string,
  floors: ApkFloor[],
  fetcher: ApkFetcher,
): Promise<{ findings: FloorFinding[]; unparsed: string[] }> {
  const [main, community, index] = await Promise.all([
    fetcher(`${SECDB}/${branch}/main.json`),
    fetcher(`${SECDB}/${branch}/community.json`),
    fetcher(`${CDN}/${branch}/main/x86_64/APKINDEX.tar.gz`),
  ]);
  const secfixes = parseSecdb(JSON.parse(main.toString("utf8")));
  for (const [name, fixes] of parseSecdb(JSON.parse(community.toString("utf8"))))
    if (!secfixes.has(name)) secfixes.set(name, fixes);
  return judgeFloors(floors, branch, secfixes, parseApkIndexOrigins(apkIndexText(index)));
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

/** Floors grouped by the branch they are judged on; `assumed` is the newest stable branch, when used. */
async function groupByBranch(
  floors: ApkFloor[],
  fetcher: ApkFetcher,
): Promise<{ byBranch: Map<string, ApkFloor[]>; assumed: string | null }> {
  let assumed: string | null = null;
  const byBranch = new Map<string, ApkFloor[]>();
  for (const floor of floors) {
    if (floor.branch.kind !== "branch" && !assumed) {
      assumed = newestStableBranch((await fetcher(`${SECDB}/`)).toString("utf8"));
      if (!assumed) throw new Error("secdb index lists no stable branch");
    }
    const branch = floor.branch.kind === "branch" ? floor.branch.branch : (assumed as string);
    byBranch.set(branch, [...(byBranch.get(branch) ?? []), floor]);
  }
  return { byBranch, assumed };
}

function verdict(
  floors: ApkFloor[],
  files: string[],
  judged: { findings: FloorFinding[]; unparsed: string[] },
  assumed: string | null,
): SecurityCheckResult {
  const { findings, unparsed } = judged;
  const notes: string[] = [];
  if (assumed)
    notes.push(
      `the base image tag names no Alpine branch, so ${assumed} (newest stable) was assumed`,
    );
  if (unparsed.length) notes.push(`not compared, version not parsed: ${unparsed.join(", ")}`);
  const tail = notes.length ? ` Note: ${notes.join("; ")}.` : "";
  if (findings.length === 0)
    return result({
      status: "pass",
      detail: `${floors.length} apk floor(s) in ${files.join(", ")} are at or above every Alpine secdb fix.${tail}`,
    });
  return result({
    status: "warn",
    severity: "high",
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
  const { floors, files } = readFloors(root);
  if (floors.length === 0)
    return result({ status: "skip", detail: "no apk add version floors in a Dockerfile" });
  if (isAirGap(env))
    return result({
      status: "skip",
      detail: `air-gap mode: ${floors.length} apk floor(s) not compared with Alpine secdb (unverified)`,
    });
  try {
    const { byBranch, assumed } = await groupByBranch(floors, fetcher);
    const judged = { findings: [] as FloorFinding[], unparsed: [] as string[] };
    for (const [branch, list] of [...byBranch].sort()) {
      const one = await judgeBranch(branch, list, fetcher);
      judged.findings.push(...one.findings);
      judged.unparsed.push(...one.unparsed);
    }
    return verdict(floors, files, judged, assumed);
  } catch (err) {
    return result({
      status: "warn",
      severity: "medium",
      didNotRun: true,
      detail: `apk floors not compared with Alpine secdb (unverified): ${(err as Error).message}`,
    });
  }
}
