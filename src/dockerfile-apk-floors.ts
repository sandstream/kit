/**
 * Dockerfile `apk add` version floors against Alpine's security database (secdb). `trivy fs` and
 * `trivy config` read the repository, not a built image, so they never see the OS packages an
 * `apk add` installs. A floor such as `'libexpat>=2.8.5-r0'` keeps admitting a version that
 * Alpine has since fixed CVEs in, and a cached build layer can keep shipping it. This module is
 * pure: it parses the Dockerfile, secdb JSON and APKINDEX text it is handed, and compares
 * versions. The fetching lives in check-apk-floors.ts.
 */
import { joinContinuations } from "./image-scan.js";
import { compareApkVersions } from "./utils/apk-version.js";

/** Which Alpine branch a stage runs on: a named one, the newest stable, or not Alpine at all. */
export type AlpineBranch =
  { kind: "branch"; branch: string } | { kind: "latest" } | { kind: "none" };

export interface ApkFloor {
  name: string;
  op: string;
  version: string;
  branch: AlpineBranch;
}

export interface FloorFinding {
  name: string;
  floor: string;
  /** The highest fixed version above the floor: the floor to raise to. */
  fixedIn: string;
  cves: string[];
  branch: string;
}

const LOWER_BOUND = /^([a-z0-9][a-z0-9+._-]*?)(>=|>|=|~)(.+)$/;
const VALUE_OPTIONS = new Set([
  "-X",
  "--repository",
  "-t",
  "--virtual",
  "-p",
  "--root",
  "--arch",
  "--cache-dir",
  "--keys-dir",
]);

/** The Alpine branch an image reference names, when it names one. */
export function alpineBranchOf(ref: string): AlpineBranch {
  const image = ref.split("@")[0];
  const slash = image.lastIndexOf("/");
  const colon = image.indexOf(":", slash + 1);
  const name = colon < 0 ? image.slice(slash + 1) : image.slice(slash + 1, colon);
  const tag = colon < 0 ? "latest" : image.slice(colon + 1);
  if (name === "alpine") {
    if (tag === "edge") return { kind: "branch", branch: "edge" };
    const m = /^(\d+)\.(\d+)/.exec(tag);
    return m ? { kind: "branch", branch: `v${m[1]}.${m[2]}` } : { kind: "latest" };
  }
  const m = /(?:^|-)alpine(\d+)\.(\d+)/.exec(tag);
  if (m) return { kind: "branch", branch: `v${m[1]}.${m[2]}` };
  return /(?:^|-)alpine$/.test(tag) ? { kind: "latest" } : { kind: "none" };
}

function unquote(word: string): string {
  return word.replace(/^['"]|['"]$/g, "");
}

/** The package floors of one `apk add` command (words after `add`, up to the next separator). */
function floorsOf(words: string[], branch: AlpineBranch): ApkFloor[] {
  const floors: ApkFloor[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = unquote(words[i]);
    if (["&&", "||", ";", "|"].includes(word)) break;
    if (VALUE_OPTIONS.has(word)) {
      i++;
      continue;
    }
    if (word.startsWith("-")) continue;
    const m = LOWER_BOUND.exec(word);
    if (m) floors.push({ name: m[1], op: m[2], version: m[3], branch });
  }
  return floors;
}

/** Every lower-bound `apk add` floor in a Dockerfile, with the Alpine branch of its stage. */
export function parseApkFloors(text: string): ApkFloor[] {
  const floors: ApkFloor[] = [];
  const stages = new Map<string, AlpineBranch>();
  let current: AlpineBranch = { kind: "none" };
  for (const line of joinContinuations(text)) {
    const words = line.trim().split(/\s+/);
    const keyword = (words[0] ?? "").toLowerCase();
    if (keyword === "from") {
      const operands = words.slice(1).filter((w) => !w.startsWith("--"));
      const base = (operands[0] ?? "").toLowerCase();
      current = stages.get(base) ?? alpineBranchOf(base);
      if (operands[1]?.toLowerCase() === "as" && operands[2])
        stages.set(operands[2].toLowerCase(), current);
      continue;
    }
    if (keyword !== "run" || current.kind === "none") continue;
    for (let i = 1; i < words.length - 1; i++) {
      if (words[i] === "apk" && words[i + 1] === "add")
        floors.push(...floorsOf(words.slice(i + 2), current));
    }
  }
  return floors;
}

export { parseSecdb } from "./alpine-secdb.js";
export { apkIndexText } from "./alpine-index-archive.js";

export { parseApkIndexOrigins } from "./alpine-index-origins.js";

/**
 * The floors that admit a version Alpine fixed CVEs in: for each, the CVEs fixed above the floor
 * and the highest such fixed version. `unparsed` lists floors with unsupported versions. `unresolved` lists packages without an origin.
 */
export function judgeFloors(
  floors: ApkFloor[],
  branch: string,
  secfixes: ReadonlyMap<string, ReadonlyMap<string, string[]>>,
  origins: ReadonlyMap<string, string>,
): { findings: FloorFinding[]; unparsed: string[]; unresolved: string[] } {
  const findings: FloorFinding[] = [];
  const unparsed: string[] = [];
  const unresolved: string[] = [];
  for (const floor of floors) {
    const origin = origins.get(floor.name);
    if (!origin) {
      unresolved.push(floor.name);
      continue;
    }
    if (compareApkVersions(floor.version, floor.version) !== 0) {
      unparsed.push(`${floor.name}${floor.op}${floor.version}`);
      continue;
    }
    const fixes = secfixes.get(origin);
    if (!fixes) continue;
    let fixedIn = "";
    const cves: string[] = [];
    for (const [version, ids] of fixes) {
      if (version === "0") continue; // listed as not fixed (or not affected) on this branch
      const cmp = compareApkVersions(floor.version, version);
      if (cmp === null || !Number.isFinite(cmp)) {
        unparsed.push(`${floor.name}${floor.op}${floor.version}`);
        continue;
      }
      if (cmp >= 0) continue;
      cves.push(...ids);
      if (!fixedIn || (compareApkVersions(version, fixedIn) ?? 0) > 0) fixedIn = version;
    }
    if (fixedIn)
      findings.push({
        name: floor.name,
        floor: floor.version,
        fixedIn,
        cves: [...new Set(cves)].sort(),
        branch,
      });
  }
  return { findings, unparsed: [...new Set(unparsed)], unresolved: [...new Set(unresolved)] };
}

/** The newest stable branch (`v3.N`) in secdb's index page. */
export function newestStableBranch(indexHtml: string): string | null {
  const branches = [...indexHtml.matchAll(/\bv(\d+)\.(\d+)\//g)].map((m) => [
    Number(m[1]),
    Number(m[2]),
  ]);
  branches.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const top = branches.at(-1);
  return top ? `v${top[0]}.${top[1]}` : null;
}
