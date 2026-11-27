/**
 * The npx trap: a bin whose name is another npm package (kit-research metaharness-artex-defense-vs-kit).
 *
 * `@metaharness/redblue` ships a bin named `redblue`, and its README says `npx redblue init`. Without a
 * local install npx resolves `redblue` as an unscoped npm name, which is an unrelated 2017 package by
 * another maintainer. `@metaharness/artex-defense` ships `artex-defense`, an npm name nobody owns yet.
 *
 * `kit triage npm` reads the triaged version's `bin` and asks the registry about every bin name that is
 * not the package's own name. Three answers: `same` (the bin is the package's own name, nothing to ask),
 * `unclaimed` (404: anyone can register it) and `other` (another package owns it). The last two print a
 * warning and are written to the triage log as `npm-bin` records, which `gate-bash` reads
 * (`install-gate-npx-bin.ts`). One GET per bin, no model, no new dependency.
 */
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  airGapView,
  fetchRegistryDoc,
  npmName,
  registrySource,
  triagedVersion,
  withCoolingLines,
  type AirGapView,
  type RegistryDoc,
} from "./triage-cooling.js";
import { TRIAGE_LOG_FILE } from "./triage-receipt.js";

export type NpxBinState = "same" | "unclaimed" | "other";

/** What npx would fetch for one bin of a triaged package, run without a local install. */
export interface NpxBinFact {
  bin: string;
  /** The triaged package that declares the bin. */
  package: string;
  state: NpxBinState;
  /** For `other`: the package npx would run instead. */
  owner?: { version?: string; maintainers: string[]; created?: string };
}

/** One `npm-bin` line of `.kit-triage.jsonl`. It records a registry fact, never a pass. */
export interface NpxBinReceipt extends NpxBinFact {
  timestamp: string;
  type: "npm-bin";
  target: string;
}

export interface NpxBinDeps {
  env: NodeJS.ProcessEnv;
  airGap: (cwd: string) => Promise<AirGapView>;
  getDoc: (url: string) => Promise<RegistryDoc | null>;
}

export const defaultNpxBinDeps: NpxBinDeps = {
  env: process.env,
  airGap: airGapView,
  getDoc: (url) => fetchRegistryDoc(url),
};

/** The unscoped names npx can fetch: npm's rule for a new package name. */
const UNSCOPED = /^[a-z0-9][a-z0-9._-]{0,213}$/;
/** A package with dozens of bins must not turn one triage into dozens of requests. */
const MAX_BINS = 10;

type Packument = {
  "dist-tags"?: { latest?: unknown };
  versions?: Record<string, { bin?: unknown } | undefined>;
  maintainers?: unknown;
  time?: { created?: unknown };
};

/** The bin names one manifest declares. A string `bin` is named after the package (scope dropped). */
export function binNames(pkg: string, manifest: unknown): string[] {
  const bin = (manifest as { bin?: unknown } | null)?.bin;
  if (typeof bin === "string") return [pkg.slice(pkg.lastIndexOf("/") + 1)];
  if (bin && typeof bin === "object" && !Array.isArray(bin)) return Object.keys(bin);
  return [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value.replace(/[^\x20-\x7e]/g, "?").slice(0, 80) : undefined;
}

/** Who owns an unscoped name: its latest version, its maintainers and its creation date. */
function ownerOf(doc: Packument): NonNullable<NpxBinFact["owner"]> {
  const people = Array.isArray(doc.maintainers) ? doc.maintainers : [];
  const maintainers = people
    .map((m) => text((m as { name?: unknown } | null)?.name))
    .filter((m): m is string => Boolean(m))
    .slice(0, 5);
  const created = text(doc.time?.created)?.slice(0, 10);
  return { version: text(doc["dist-tags"]?.latest), maintainers, ...(created ? { created } : {}) };
}

/** The state of one bin name, or why it could not be read. */
async function lookupBin(
  pkg: string,
  bin: string,
  deps: NpxBinDeps,
  air: AirGapView,
): Promise<NpxBinFact | { skip: string }> {
  if (bin === pkg) return { bin, package: pkg, state: "same" };
  if (!UNSCOPED.test(bin)) return { skip: "not a name npx can fetch from the registry" };
  const source = registrySource("npm", bin, deps, air);
  if ("skip" in source) return source;
  const doc = await deps.getDoc(source.url);
  if (doc?.status === 404) return { bin, package: pkg, state: "unclaimed" };
  if (!doc || doc.status !== 200 || !doc.body || typeof doc.body !== "object") {
    return { skip: "the registry could not be read" };
  }
  return { bin, package: pkg, state: "other", owner: ownerOf(doc.body as Packument) };
}

/** The report line for one fact, in triage.py's format. */
export function binLine(fact: NpxBinFact): string {
  const { bin, package: pkg } = fact;
  const fix = `install ${pkg} first, or run npx -p ${pkg} ${bin}`;
  if (fact.state === "same") return `  . npx bin ${bin}: the package's own name`;
  if (fact.state === "unclaimed") {
    return `  ! WARNING: npx ${bin}: without a local install npx fetches the npm name '${bin}', which nobody has registered and anyone can claim -- ${fix}`;
  }
  const o = fact.owner;
  const who = [
    o?.maintainers.length ? `maintainers ${o.maintainers.join(", ")}` : "",
    o?.created ? `created ${o.created}` : "",
  ].filter(Boolean);
  const v = o?.version ? `@${o.version}` : "";
  return `  ! WARNING: npx ${bin}: without a local install npx runs the other npm package ${bin}${v}${who.length ? ` (${who.join(", ")})` : ""}, not ${pkg} -- ${fix}`;
}

/** The bins the triaged version declares, read from the package's own packument. */
async function declaredBins(
  pkg: string,
  version: string,
  deps: NpxBinDeps,
  air: AirGapView,
): Promise<string[] | { skip: string }> {
  const source = registrySource("npm", pkg, deps, air);
  if ("skip" in source) return source;
  const doc = await deps.getDoc(source.url);
  const body = doc?.status === 200 ? (doc.body as Packument | null) : null;
  if (!body?.versions) return { skip: "the registry could not be read again" };
  return binNames(pkg, body.versions[version]);
}

/**
 * Check the bins of an npm triage and fold the findings into its report. The verdict does not change:
 * the package is what it is; what changes is what `npx <bin>` would run in its place.
 */
export async function npxBinCheck(
  cwd: string,
  target: string,
  result: { passed: boolean; output: string },
  deps: NpxBinDeps = defaultNpxBinDeps,
): Promise<{ passed: boolean; output: string; npxBins: NpxBinFact[] }> {
  const pkg = npmName(target);
  const version = triagedVersion(result.output);
  if (!pkg || !version) return { ...result, npxBins: [] };
  const air = await deps.airGap(cwd);
  const bins = await declaredBins(pkg, version, deps, air);
  if ("skip" in bins) {
    const line = `  ~ NOT CHECKED: npx bin names -- ${bins.skip}`;
    return {
      ...result,
      output: withCoolingLines(result.output, { lines: [line], held: false }),
      npxBins: [],
    };
  }
  const lines: string[] = [];
  const facts: NpxBinFact[] = [];
  for (const bin of bins.slice(0, MAX_BINS)) {
    const fact = await lookupBin(pkg, bin, deps, air);
    if ("skip" in fact) lines.push(`  ~ NOT CHECKED: npx bin ${text(bin)} -- ${fact.skip}`);
    else {
      facts.push(fact);
      lines.push(binLine(fact));
    }
  }
  if (bins.length > MAX_BINS) {
    lines.push(
      `  ~ NOT CHECKED: npx bin names -- ${bins.length - MAX_BINS} more bins than the ${MAX_BINS} read`,
    );
  }
  return {
    ...result,
    output: withCoolingLines(result.output, { lines, held: false }),
    npxBins: facts,
  };
}

/**
 * Write the `unclaimed` and `other` facts to the triage log as `npm-bin` records, whatever the verdict:
 * they describe the registry, not a grant. Readers that look for PASS receipts match on `npm`, `pip`
 * or `skill` and skip them. Returns false when the log could not be written.
 */
export async function recordNpxBins(
  cwd: string,
  facts: NpxBinFact[] | undefined,
): Promise<boolean> {
  const risky = (facts ?? []).filter((f) => f.state !== "same");
  if (risky.length === 0) return true;
  const timestamp = new Date().toISOString();
  const lines = risky.map((f) => {
    const receipt: NpxBinReceipt = { timestamp, type: "npm-bin", target: f.bin, ...f };
    return JSON.stringify(receipt) + "\n";
  });
  try {
    await appendFile(resolve(cwd, TRIAGE_LOG_FILE), lines.join(""), "utf-8");
    return true;
  } catch {
    return false;
  }
}
