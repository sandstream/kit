/**
 * Reviewed GuardDog exceptions, kept in `guarddog-exceptions.json` at the repository root.
 *
 * GuardDog has no ignore list, so one reviewed false positive keeps the malware check red for good.
 * An entry here is narrow on purpose. It names one npm package at one exact version, one rule, one
 * file inside that package and the SHA-256 of that file as installed under `node_modules`. It
 * carries a reason and ends within 90 days, like an `audit-exceptions.json` entry.
 *
 * Anything else still counts: another version, another rule, another file, a file whose bytes
 * changed, or a package that is not installed at that version, since kit then cannot hash the file.
 * An expired entry covers nothing. A rule that fails to run is never excepted, and a metadata
 * finding names no file, so neither can be covered here.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { endOfDay } from "./audit-exceptions.js";
import type { GuardDogWaiver } from "./guarddog.js";
import { readRegularFileBytesIfPresent } from "./upstream-safe-read.js";

export const GUARDDOG_EXCEPTIONS_FILE = "guarddog-exceptions.json";

export interface GuardDogException {
  package: string;
  version: string;
  rule: string;
  /** A path inside the package, with `/` separators, such as `dist/index.js`. */
  file: string;
  sha256: string;
  reason: string;
  /** Last day, inclusive, as YYYY-MM-DD in UTC. */
  expires: string;
}

const FIELDS = ["package", "version", "rule", "file", "sha256", "reason", "expires"];
const MAX_DAYS_AHEAD = 90;
const DAY_MS = 86_400_000;
const NPM_NAME = /^(?:@[a-z\d_~][a-z\d._~-]*\/)?[a-z\d_~][a-z\d._~-]*$/i;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/i;
const RULE = /^[a-z][a-z\d_-]*$/;
const SHA256 = /^[\da-f]{64}$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function badFile(file: unknown): boolean {
  if (typeof file !== "string" || file === "" || /[\\*?[\]{}:]/.test(file)) return true;
  return file.startsWith("/") || file.split("/").some((part) => part === "" || part === "..");
}

function fieldProblem(entry: Record<string, unknown>): string | undefined {
  const unknown = Object.keys(entry).find((key) => !FIELDS.includes(key));
  if (unknown) return `unknown field "${unknown}"`;
  const { package: name, version, rule, sha256 } = entry;
  if (typeof name !== "string" || !NPM_NAME.test(name)) return "package must be an npm name";
  if (typeof version !== "string" || !EXACT_VERSION.test(version)) {
    return "version must be one exact version such as 1.2.3";
  }
  if (typeof rule !== "string" || !RULE.test(rule)) return "rule must be one GuardDog rule id";
  if (badFile(entry.file)) return "file must be one relative path inside the package";
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) {
    return "sha256 must be the file's lowercase hex SHA-256";
  }
  return undefined;
}

function reasonExpiryProblem(entry: Record<string, unknown>, now: Date): string | undefined {
  const { reason, expires } = entry;
  if (typeof reason !== "string" || reason.trim() === "") return "reason is required";
  const end = typeof expires === "string" ? endOfDay(expires) : NaN;
  if (Number.isNaN(end)) return "expires must be a date like 2026-12-31";
  if (end - now.getTime() > MAX_DAYS_AHEAD * DAY_MS) {
    return `expires must be within ${MAX_DAYS_AHEAD} days, so no exception is permanent`;
  }
  return undefined;
}

/** Validate the contents of `guarddog-exceptions.json`. Bad entries are dropped and named. */
export function parseGuardDogExceptions(
  raw: unknown,
  now: Date = new Date(),
): { exceptions: GuardDogException[]; problems: string[] } {
  if (!Array.isArray(raw)) {
    return { exceptions: [], problems: [`${GUARDDOG_EXCEPTIONS_FILE} must hold a list`] };
  }
  const exceptions: GuardDogException[] = [];
  const problems: string[] = [];
  raw.forEach((entry, i) => {
    const at = `GuardDog exception ${i + 1}`;
    if (!isRecord(entry)) return problems.push(`${at}: not an object`);
    const problem = fieldProblem(entry) ?? reasonExpiryProblem(entry, now);
    if (problem) return problems.push(`${at}: ${problem}`);
    const e = entry as unknown as GuardDogException;
    exceptions.push({ ...e, reason: e.reason.trim() });
  });
  return { exceptions, problems };
}

/** SHA-256 of a file of a package installed at exactly this version, or undefined. */
function installedDigest(root: string, entry: GuardDogException): string | undefined {
  const dir = join(root, "node_modules", ...entry.package.split("/"));
  try {
    const manifest = readRegularFileBytesIfPresent(join(dir, "package.json"));
    const installed = manifest ? (JSON.parse(manifest.toString("utf8")) as unknown) : undefined;
    if (!isRecord(installed) || installed.version !== entry.version) return undefined;
    const bytes = readRegularFileBytesIfPresent(join(dir, ...entry.file.split("/")));
    return bytes ? createHash("sha256").update(bytes).digest("hex") : undefined;
  } catch {
    return undefined;
  }
}

/** The file a source finding names, without the archive root folder and the line number. */
function findingFile(location: string): string | undefined {
  return /^[^/]+\/(.+):\d+$/.exec(location.replace(/\\/g, "/"))?.[1];
}

const label = (e: GuardDogException) => `${e.package}@${e.version} ${e.rule} ${e.file}`;

class Waiver implements GuardDogWaiver {
  private readonly used = new Set<GuardDogException>();
  private readonly stale = new Set<string>();
  private readonly digests = new Map<GuardDogException, string | undefined>();

  constructor(
    private readonly root: string,
    private readonly exceptions: GuardDogException[],
    private readonly problems: string[],
    private readonly now: Date,
  ) {}

  finding(dependency: string, version: string, rule: string, location: string): boolean {
    const file = findingFile(location);
    const candidates = this.exceptions.filter(
      (e) =>
        e.package === dependency && e.version === version && e.rule === rule && e.file === file,
    );
    for (const e of candidates) {
      if (endOfDay(e.expires) < this.now.getTime()) {
        this.stale.add(`expired ${e.expires}: ${label(e)}`);
        continue;
      }
      if (!this.digests.has(e)) this.digests.set(e, installedDigest(this.root, e));
      if (this.digests.get(e) !== e.sha256) {
        this.stale.add(`file differs or is not installed at that version: ${label(e)}`);
        continue;
      }
      this.used.add(e);
      return true;
    }
    return false;
  }

  summary(): string {
    const notes = [...this.problems];
    if (this.used.size > 0) {
      const ends = [...this.used].map((e) => e.expires).sort();
      notes.push(
        `${this.used.size} reviewed GuardDog exception(s) from ${GUARDDOG_EXCEPTIONS_FILE} applied, ` +
          `the first ends ${ends[0]}: ${[...this.used].map(label).join("; ")}`,
      );
    }
    for (const note of this.stale) notes.push(`GuardDog exception not applied, ${note}`);
    return notes.join(". ");
  }
}

/** The reviewed GuardDog exceptions of the repo at `root`, ready for classifyGuardDog. */
export async function guardDogWaiver(
  root: string,
  now: Date = new Date(),
): Promise<GuardDogWaiver> {
  let text: string;
  try {
    text = await readFile(join(root, GUARDDOG_EXCEPTIONS_FILE), "utf8");
  } catch {
    return new Waiver(root, [], [], now);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return new Waiver(root, [], [`${GUARDDOG_EXCEPTIONS_FILE} is not valid JSON`], now);
  }
  const { exceptions, problems } = parseGuardDogExceptions(raw, now);
  return new Waiver(root, exceptions, problems, now);
}
