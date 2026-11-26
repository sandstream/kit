// `kit triage release <url|file>`: check a prebuilt release archive or binary before it is
// extracted, made executable, run or put on PATH. A pass for a URL records a `release` receipt
// for it in `.kit-triage.jsonl`, with the file's digest.
import {
  closeSync,
  constants,
  createWriteStream,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { c } from "../utils/colors.js";
import { flagValue, hasFlag } from "../utils/flags.js";
import {
  RELEASE_CHECKS,
  triageRelease,
  type ReleaseCheckName,
  type ReleaseDeps,
  type ReleaseOptions,
  type ReleaseReport,
  type ReleaseStatus,
} from "../release-triage.js";
import { canonicalReleaseUrl, RELEASE_RECEIPT_TYPE, urlFileName } from "../release-url.js";

const VALUE_FLAGS = [
  "--checksum",
  "--repo",
  "--url",
  "--minisign-key",
  "--cosign-key",
  "--accept-unverified",
];
const MAX_TEXT = 2_000_000;
/** Largest asset downloaded for a check. A bigger one is refused, not partly checked. */
const MAX_ASSET = 2 * 1024 * 1024 * 1024;
const USAGE =
  "usage: kit triage release <url|file> [--url URL] [--checksum HEX|FILE] [--repo owner/repo] [--minisign-key KEY|FILE] [--cosign-key PEM] [--accept-unverified check,...] [--json]";

const NOTE =
  "Checks the file against what its publisher says about it. Nothing in it was extracted or run, and a pass cannot say the software is safe.";

const MARK: Record<ReleaseStatus, string> = {
  pass: `${c.green}✓${c.reset}`,
  fail: `${c.red}✗${c.reset}`,
  unverified: `${c.yellow}?${c.reset}`,
};

function positional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.includes(args[i]!)) i++;
    else if (!args[i]!.startsWith("--")) return args[i];
  }
  return undefined;
}

/** A small text file through one descriptor (checked with fstat on it), or null when unusable. */
function readSmallFile(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(resolve(path), constants.O_RDONLY);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    return st.isFile() && st.size <= MAX_TEXT ? readFileSync(fd, "utf8") : null;
  } finally {
    closeSync(fd);
  }
}

type Parsed = { opts: ReleaseOptions } | { error: string };

function checksumOption(
  given: string | undefined,
): Pick<ReleaseOptions, "sha256" | "shasumsText"> | string {
  if (given === undefined) return {};
  if (/^[0-9a-fA-F]{64}$/.test(given)) return { sha256: given };
  const text = readSmallFile(given);
  return text === null
    ? `--checksum needs 64 hex digits or a readable checksum list, not ${JSON.stringify(given)}`
    : { shasumsText: text };
}

function acceptOption(given: string | undefined): ReleaseCheckName[] | string {
  if (given === undefined) return [];
  const names = given
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = names.filter((n) => !(RELEASE_CHECKS as readonly string[]).includes(n));
  return bad.length
    ? `--accept-unverified takes ${RELEASE_CHECKS.join(", ")}, not ${bad.join(", ")}`
    : (names as ReleaseCheckName[]);
}

function keyOption(
  flag: string,
  given: string | undefined,
  inline: RegExp,
): string | undefined | { error: string } {
  if (given === undefined) return undefined;
  if (inline.test(given)) return given;
  return (
    readSmallFile(given) ?? {
      error: `${flag} needs a key or a readable key file, not ${JSON.stringify(given)}`,
    }
  );
}

function options(args: string[]): Parsed {
  const sum = checksumOption(flagValue(args, "--checksum"));
  if (typeof sum === "string") return { error: sum };
  const accept = acceptOption(flagValue(args, "--accept-unverified"));
  if (typeof accept === "string") return { error: accept };
  const repo = flagValue(args, "--repo");
  if (repo !== undefined && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo))
    return { error: "--repo needs owner/repo" };
  const minisignKey = keyOption(
    "--minisign-key",
    flagValue(args, "--minisign-key"),
    /^R[A-Za-z0-9+/]{54}=*$/,
  );
  const cosignKey = keyOption("--cosign-key", flagValue(args, "--cosign-key"), /^-----BEGIN /);
  for (const k of [minisignKey, cosignKey]) if (typeof k === "object") return k;
  return {
    opts: {
      ...sum,
      accept,
      repo,
      minisignKey: minisignKey as string | undefined,
      cosignKey: cosignKey as string | undefined,
    },
  };
}

function render(r: ReleaseReport): void {
  console.log(`${c.bold}kit triage release${c.reset} — ${r.url ?? r.file}`);
  console.log(`  sha256 ${r.sha256}`);
  for (const k of r.checks) {
    const note = r.accepted.includes(k.name) ? ` ${c.dim}(accepted unverified)${c.reset}` : "";
    console.log(`  ${MARK[k.status]} ${k.name}: ${k.detail}${note}`);
  }
  const verdict = r.passed ? `${c.green}passed${c.reset}` : `${c.red}not passed${c.reset}`;
  console.log(`\n  ${verdict}. ${c.dim}${NOTE}${c.reset}`);
}

/** Download `url` into a fresh private directory. Throws with a reason on any failure. */
async function download(url: string, dir: string): Promise<string> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(300_000) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  // A missing or garbled length is not a small one: the stream below still counts every byte.
  const length = Number(res.headers.get("content-length") ?? "0");
  if (!Number.isFinite(length) || length > MAX_ASSET)
    throw new Error(`the asset is ${length} bytes, over the ${MAX_ASSET}-byte limit`);
  const file = join(dir, urlFileName(url).replace(/[^A-Za-z0-9._-]/g, "_") || "asset");
  let seen = 0;
  const body = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
  body.on("data", (chunk: Buffer) => {
    seen += chunk.length;
    if (seen > MAX_ASSET) body.destroy(new Error(`the asset is over the ${MAX_ASSET}-byte limit`));
  });
  await pipeline(body, createWriteStream(file, { mode: 0o600, flags: "wx" }));
  return file;
}

interface Target {
  url: string | null;
  file: string;
  cleanup?: string;
}

async function resolveTarget(given: string, args: string[]): Promise<Target | string> {
  const asUrl = /^https?:\/\//i.test(given) ? canonicalReleaseUrl(given) : null;
  if (/^https?:\/\//i.test(given) && !asUrl)
    return `not a URL kit can fetch: ${JSON.stringify(given)}`;
  const named = flagValue(args, "--url");
  const url = named === undefined ? asUrl : canonicalReleaseUrl(named);
  if (named !== undefined && !url)
    return `--url needs an http(s) URL, not ${JSON.stringify(named)}`;
  if (!asUrl) return { url, file: resolve(given) };
  const { defaultReleaseDeps } = await import("./triage-release-deps.js");
  if ((await defaultReleaseDeps(process.cwd())).airGap) {
    return "air-gap is on: kit downloads nothing. Fetch the file yourself and run kit triage release <file> --url <url>";
  }
  const dir = mkdtempSync(join(tmpdir(), "kit-release-"));
  try {
    return { url: asUrl, file: await download(asUrl, dir), cleanup: dir };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    return `cannot download ${asUrl}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function record(report: ReleaseReport): Promise<string | null> {
  if (!report.passed || !report.url) return null;
  const { appendTriagePass } = await import("../triage-receipt.js");
  await appendTriagePass({
    type: RELEASE_RECEIPT_TYPE,
    target: report.url,
    sandbox: false,
    contentDigest: `sha256:${report.sha256}`,
  });
  return report.url;
}

/** Exit status: true only when the release passed and its receipt was recorded (or there was no URL to record). */
export async function cmdTriageRelease(args: string[], deps?: ReleaseDeps): Promise<boolean> {
  const given = positional(args);
  if (!given) return fail(USAGE, true);
  const parsed = options(args);
  if ("error" in parsed) return fail(parsed.error);
  const target = await resolveTarget(given, args);
  if (typeof target === "string") return fail(target);
  try {
    const live =
      deps ?? (await (await import("./triage-release-deps.js")).defaultReleaseDeps(process.cwd()));
    const report = await triageRelease(target, parsed.opts, live);
    const recorded = await record(report);
    if (hasFlag(args, "--json"))
      console.log(JSON.stringify({ ...report, recorded, note: NOTE }, null, 2));
    else render(report);
    if (report.passed && !recorded)
      console.log(
        `  ${c.dim}No receipt: give --url so kit gate-bash can match the fetch.${c.reset}`,
      );
    return report.passed;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message : "error");
    return fail(`cannot check ${JSON.stringify(target.file)} (${code})`);
  } finally {
    if (target.cleanup) rmSync(target.cleanup, { recursive: true, force: true });
  }
}

function fail(message: string, usage = false): false {
  console.error(usage ? message : `kit triage release: ${message}`);
  return false;
}
