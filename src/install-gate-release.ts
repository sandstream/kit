/**
 * The install gate for a prebuilt binary (kit-research#233, G1). `npm i -g x` is held by the
 * cooling period and `curl … | sh` is refused, but a download followed by an extract, a
 * `chmod +x`, a run or a move onto PATH passed silently. This module reads one command's
 * segments in order and finds those chains:
 *
 *   fetch (curl, wget, gh release download, Invoke-WebRequest -OutFile, Start-BitsTransfer)
 *     → [extract (tar, unzip, 7z, gunzip…, Expand-Archive)]
 *     → make executable | run | build in the extracted tree | move or install onto PATH
 *
 * Each chain needs a fresh `kit triage release <url>` receipt (`.kit-triage.jsonl`, type
 * `release`, the 7-day window other triage uses) in the directory the command runs in. A bare
 * download is never refused: only the chain to execution or PATH. A chain the gate cannot read
 * (a URL or file name the shell expands, `gh release download` with a pattern) is refused as
 * unverifiable, as the gate does elsewhere.
 *
 * A source tarball counts. `./configure`, `make` and `cmake` run build files that came in the
 * download, so a build run inside the extracted tree (after `cd` into it, or `make -C dir`) is
 * an execution of the fetched code. A build in the caller's own tree after extracting a dataset
 * next to it is not. Pure apart from reading the receipt file.
 */
import { freshReceipts } from "./install-gate-bare.js";
import { canonicalReleaseUrl, RELEASE_RECEIPT_TYPE } from "./release-url.js";
import {
  commandWords,
  DYNAMIC,
  fetchesOf,
  fileName,
  type Fetch,
} from "./install-gate-release-steps.js";
import {
  buildDirectory,
  cdTarget,
  destinationKind,
  extractOf,
  installLocation,
  isBuild,
  madeExecutable,
  pathLike,
  placeOf,
  runOperand,
} from "./install-gate-release-uses.js";
import { shellPipelines } from "./install-gate-words.js";

export interface ReleaseChain {
  /** The fetched URL, or null when the gate could not read it. */
  url: string | null;
  why?: string;
  /** What was done with it, in words: "made executable (chmod +x tool)". */
  step: string;
}

interface Tree {
  fetch: Fetch;
  /** Where it was extracted to, when named. */
  dest?: string;
}

interface State {
  fetched: Fetch[];
  extracted: Tree[];
  /** True after a `cd` into a relative directory once something was extracted. */
  inTree: boolean;
  chains: ReleaseChain[];
}

function globMatch(pattern: string, name: string): boolean {
  const re = pattern
    .replace(/[.+^${}()|\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${re}$`).test(name);
}

/** True when `operand` may be a file `fetch` saved. An expanded operand may be anything. */
function namesFetched(fetch: Fetch, operand: string): boolean {
  if (fetch.names === "any" || DYNAMIC.test(operand)) return true;
  const name = fileName(operand);
  if (/[*?]/.test(name)) return [...fetch.names].some((n) => globMatch(name, n));
  return fetch.names.has(name);
}

/**
 * True when `operand` may come from an extracted tree: under its destination, expanded, or
 * relative. A bare name (`tool`) counts for chmod and moves (`bare`), and for a run only once the
 * command has `cd`'d into the tree: `python train.py` beside an extracted dataset is the
 * caller's own script.
 */
function fromTree(tree: Tree, operand: string, state: State, bare = true): boolean {
  if (DYNAMIC.test(operand)) return true;
  const p = operand.replace(/\\/g, "/");
  if (
    tree.dest &&
    (DYNAMIC.test(tree.dest) || p.startsWith(tree.dest.replace(/\\/g, "/").replace(/\/?$/, "/")))
  )
    return true;
  const absolute = p.startsWith("/") || /^[A-Za-z]:\//.test(p) || p.startsWith("~");
  return !absolute && (bare || pathLike(operand) || state.inTree);
}

function sourcesOf(operand: string, state: State, bare = true): Fetch[] {
  return [
    ...state.fetched.filter((f) => namesFetched(f, operand)),
    ...state.extracted.filter((t) => fromTree(t, operand, state, bare)).map((t) => t.fetch),
  ];
}

function chain(state: State, sources: Fetch[], step: string): void {
  for (const f of sources) state.chains.push({ url: f.url, why: f.why, step });
}

function noteExtract(argv: string[], state: State, piped: Fetch | null): boolean {
  const x = extractOf(argv);
  if (!x) return false;
  const from =
    x.archives === "stdin"
      ? piped
        ? [piped]
        : []
      : x.archives.flatMap((a) => sourcesOf(a, state));
  for (const fetch of from) state.extracted.push({ fetch, dest: x.dest });
  if (x.dest && installLocation(x.dest))
    chain(state, from, `extracted into ${x.dest} (${argv.join(" ")})`);
  return true;
}

function notePlace(argv: string[], state: State): boolean {
  const place = placeOf(argv);
  if (!place) return false;
  const kind = destinationKind(place.dest);
  for (const source of place.sources) {
    const from = sourcesOf(source, state);
    if (from.length === 0) continue;
    if (place.install || kind !== "local") {
      const where =
        kind === "dynamic" ? `${place.dest}, a destination the shell expands` : place.dest;
      chain(state, from, `${place.install ? "installed" : "put"} at ${where} (${argv.join(" ")})`);
    } else {
      // A rename keeps the taint: `mv tool.tgz x.tgz && tar xzf x.tgz` is the same download.
      state.fetched.push(...from.map((f) => ({ ...f, names: new Set([fileName(place.dest)]) })));
    }
  }
  return true;
}

function noteRun(argv: string[], state: State): void {
  for (const file of madeExecutable(argv))
    chain(state, sourcesOf(file, state), `made executable (${argv.join(" ")})`);
  const run = runOperand(argv);
  if (run) chain(state, sourcesOf(run, state, false), `run (${argv.join(" ")})`);
  if (isBuild(argv) && state.extracted.length) {
    const dir = buildDirectory(argv);
    const inside = dir
      ? state.extracted.filter((t) => fromTree(t, `${dir}/`, state))
      : state.inTree
        ? state.extracted
        : [];
    chain(
      state,
      inside.map((t) => t.fetch),
      `built from the extracted tree (${argv.join(" ")})`,
    );
  }
}

function noteStage(argv: string[], state: State, piped: Fetch | null): Fetch | null {
  const fetches = fetchesOf(argv);
  if (fetches) {
    state.fetched.push(...fetches.filter((f) => !f.stdout));
    return fetches.find((f) => f.stdout) ?? null;
  }
  if (noteExtract(argv, state, piped) || notePlace(argv, state)) return null;
  const cd = cdTarget(argv);
  if (cd !== null) {
    state.inTree = state.extracted.length > 0 && !/^(?:~|\/|[A-Za-z]:)/.test(cd);
    return null;
  }
  noteRun(argv, state);
  return null;
}

/** Every fetch-to-execution chain in one command, in order. */
export function releaseChains(command: string): ReleaseChain[] {
  const state: State = { fetched: [], extracted: [], inTree: false, chains: [] };
  for (const pipeline of shellPipelines(command)) {
    let piped: Fetch | null = null;
    for (const stage of pipeline) {
      const argv = commandWords(stage);
      if (argv.length > 0) piped = noteStage(argv, state, piped);
    }
  }
  return state.chains;
}

const MAX_SHOWN = 120;
const shorten = (s: string): string => (s.length > MAX_SHOWN ? `${s.slice(0, MAX_SHOWN)}…` : s);

/** Why the chains in a command are refused, or undefined when each has a fresh receipt in `cwd`. */
export function releaseRefusal(
  chains: ReleaseChain[],
  cwd: string | undefined,
): string | undefined {
  if (chains.length === 0) return undefined;
  const unreadable = chains.find((c) => c.url === null || canonicalReleaseUrl(c.url) === null);
  if (unreadable) {
    return `release binary: a download is ${shorten(unreadable.step)}, but the gate cannot read what was fetched (${unreadable.why ?? `not an http(s) URL: ${unreadable.url}`}). Fetch a literal https URL and run \`kit triage release <url>\` first (fail-closed)`;
  }
  const urls = [...new Set(chains.map((c) => canonicalReleaseUrl(c.url!)!))];
  if (!cwd) {
    return `release binary: ${urls[0]} is fetched and ${shorten(chains[0]!.step)}, and the gate has no directory to read triage receipts from. Run \`kit triage release ${urls[0]}\` in the project first (fail-closed)`;
  }
  const fresh = freshReceipts(cwd, RELEASE_RECEIPT_TYPE, (t) => canonicalReleaseUrl(t) ?? t);
  const missing = urls.filter((u) => !fresh.has(u));
  if (missing.length === 0) return undefined;
  const first = chains.find((c) => canonicalReleaseUrl(c.url!) === missing[0])!;
  const more =
    missing.length > 1 ? ` (and ${missing.length - 1} more: ${missing.slice(1).join(", ")})` : "";
  return `release binary: ${missing[0]} is fetched and ${shorten(first.step)}, with no fresh \`kit triage release\` receipt in ${cwd}${more}. Run \`kit triage release ${missing[0]}\` first (fail-closed)`;
}
