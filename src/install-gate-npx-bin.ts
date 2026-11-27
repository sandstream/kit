/**
 * `npx <bin>` where the bin belongs to a scoped package (kit-research metaharness-artex-defense-vs-kit).
 *
 * A README that installs `@metaharness/redblue` and then says `npx redblue init` is right only where
 * the scoped package is installed. Anywhere else npx fetches the unscoped npm name `redblue`, an
 * unrelated package, and the gate triaged that package on its own merits and let it through.
 *
 * `kit triage npm` writes an `npm-bin` record to `.kit-triage.jsonl` when a bin's unscoped name is
 * another package's (`other`) or nobody's (`unclaimed`) (triage-npm-bins.ts). This module reads those
 * records for a plain runner invocation (`npx`, `npm exec`, `pnpm dlx`, `yarn dlx`, `bunx`) of an
 * unscoped name, and refuses it. A local `node_modules/.bin/<name>` still allows it, decided by
 * `shadowedBins` exactly as before; so does a PASS receipt for the unscoped name itself that is newer
 * than the record, which is how an operator says that package is the one they mean.
 *
 * Read from the triage log only: no network, no model. Names the parser could not resolve (shell
 * expansion, `$(...)`) never reach here; the parser has already refused them as unverifiable.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { refIsBareName } from "./install-gate-cwd.js";
import { TRIAGE_LOG_FILE } from "./triage-receipt.js";

interface BinRecord {
  at: number;
  package: string;
  state: "other" | "unclaimed";
  owner?: { version?: string; maintainers?: string[]; created?: string };
}

interface LogView {
  /** The newest `npm-bin` record per lower-cased bin name. */
  bins: Map<string, BinRecord>;
  /** The newest `npm` PASS receipt per lower-cased package name. */
  passes: Map<string, number>;
}

const SCOPED = /^@[a-z0-9._-]+\/[a-z0-9._-]+$/i;

function npmReceiptName(target: string): string {
  const at = target.lastIndexOf("@");
  return (at > 0 ? target.slice(0, at) : target).toLowerCase();
}

/** One `npm-bin` line as a record, or null when it is not one this module trusts. */
function binRecord(entry: Record<string, unknown>, at: number): BinRecord | null {
  const { state, package: pkg } = entry;
  if (state !== "other" && state !== "unclaimed") return null;
  if (typeof pkg !== "string" || !SCOPED.test(pkg)) return null;
  const owner = entry.owner && typeof entry.owner === "object" ? entry.owner : undefined;
  return { at, package: pkg, state, ...(owner ? { owner: owner as BinRecord["owner"] } : {}) };
}

function keepNewer<T extends { at: number } | number>(map: Map<string, T>, key: string, v: T) {
  const prev = map.get(key);
  const at = (x: T) => (typeof x === "number" ? x : x.at);
  if (prev === undefined || at(v) >= at(prev)) map.set(key, v);
}

function readLog(dir: string): LogView {
  const view: LogView = { bins: new Map(), passes: new Map() };
  const file = join(dir, TRIAGE_LOG_FILE);
  if (!existsSync(file)) return view;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // a torn line proves nothing
    }
    const at = typeof entry?.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isFinite(at) || typeof entry.target !== "string") continue;
    if (entry.type === "npm") keepNewer(view.passes, npmReceiptName(entry.target), at);
    if (entry.type !== "npm-bin") continue;
    const record = binRecord(entry, at);
    if (record) keepNewer(view.bins, entry.target.toLowerCase(), record);
  }
  return view;
}

function refusal(name: string, r: BinRecord): string {
  const o = r.owner;
  const who = [
    o?.version ? `${name}@${o.version}` : "",
    o?.maintainers?.length ? `maintainers ${o.maintainers.join(", ")}` : "",
    o?.created ? `created ${o.created}` : "",
  ].filter(Boolean);
  const what =
    r.state === "unclaimed"
      ? `the npm name '${name}' is not registered, so anyone can claim it`
      : `the npm name '${name}' is another package${who.length ? ` (${who.join(", ")})` : ""}`;
  return (
    `\`${name}\` is a bin of ${r.package} (kit triage), but ${what}; with no local install ` +
    `the runner would fetch that name, not ${r.package}. Install ${r.package} first, or run ` +
    `\`npx -p ${r.package} ${name}\` (fail-closed)`
  );
}

/**
 * Why a plain runner invocation of an unscoped name is refused, or undefined. `candidates` are the
 * probe's runner names, `refs` its triage refs (a candidate counts only when it is the fetched ref, so
 * `npm init foo`, which fetches `create-foo`, is not read as `foo`), `shadowed` the names a local bin
 * provides. Without a directory there is no triage log to read, and nothing changes.
 */
export function npxBinRefusal(
  probe: { refs: string[]; runnerBinCandidates: string[] },
  shadowed: string[],
  cwd?: string,
): string | undefined {
  if (!cwd) return undefined;
  const names = probe.runnerBinCandidates.filter(
    (name) =>
      !name.startsWith("@") &&
      !shadowed.includes(name) &&
      probe.refs.some((ref) => refIsBareName(ref, name)),
  );
  if (names.length === 0) return undefined;
  const log = readLog(cwd);
  for (const name of names) {
    const record = log.bins.get(name.toLowerCase());
    if (!record) continue;
    const passed = log.passes.get(name.toLowerCase());
    if (passed !== undefined && passed > record.at) continue;
    return refusal(name, record);
  }
  return undefined;
}
