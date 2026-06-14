/**
 * Bumblebee — managed supply-chain exposure scanner.
 *
 * Downloads, verifies, and caches a pinned release of perplexityai/bumblebee
 * (a read-only inventory scanner that flags installed packages matching known
 * supply-chain compromise catalogs), then runs it against the machine/project.
 *
 * No Go toolchain is required: we fetch the prebuilt static binary from GitHub
 * releases, verify it against a checksum embedded in this file, and cache it
 * under ~/.kit/tools/bumblebee/<version>/. The release tarball also bundles
 * the official threat_intel/ exposure catalogs, which --exposure-catalog reads.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  writeFile,
  mkdir,
  mkdtemp,
  rm,
  chmod,
  access,
  rename,
  readdir,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);

/** Raised when a downloaded artifact fails SHA-256 verification (possible tampering). */
export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrityError";
  }
}

/** Why a scanner install could not be produced. `integrity` is a security event. */
export type EnsureFailureKind = "unsupported" | "config" | "network" | "integrity";

export interface EnsureResult {
  install?: ScannerInstall;
  reason?: string;
  kind?: EnsureFailureKind;
}

/**
 * Pinned bumblebee release. Bump deliberately, and update TARBALL_CHECKSUMS to
 * match the release's checksums.txt — the two MUST move together.
 */
export const BUMBLEBEE_VERSION = "0.1.1";

const RELEASE_BASE_URL =
  "https://github.com/perplexityai/bumblebee/releases/download";

/**
 * SHA-256 of each release tarball, copied from the pinned release's
 * checksums.txt. Embedding the digests here (rather than trusting a fetched
 * checksums.txt) means tampering with a download alone cannot pass
 * verification — an attacker would also have to compromise the published
 * kit package itself.
 */
export const TARBALL_CHECKSUMS: Record<string, string> = {
  "bumblebee_0.1.1_darwin_amd64.tar.gz":
    "dd3b2573a974a2786f58215483420fa11cf62b39ff4032693f1440575940dc25",
  "bumblebee_0.1.1_darwin_arm64.tar.gz":
    "dc0a620e54e85f998c2280b0323763c342973a25eda475d8036d16b01820a2bf",
  "bumblebee_0.1.1_linux_amd64.tar.gz":
    "0ef1c56c85a67c10f7211883c0eb5fb902de705cc30bbca0bc6f4d60941547da",
  "bumblebee_0.1.1_linux_arm64.tar.gz":
    "41aad0296bb6c88e746b237ed32eaa3b9b93c48770a51cd66f736f8a4d07a7d1",
};

export interface PlatformTarget {
  os: "linux" | "darwin";
  arch: "amd64" | "arm64";
  assetName: string;
  checksum: string;
}

/**
 * Map Node's process.platform/arch to a bumblebee release asset.
 * Returns null on unsupported platforms (bumblebee ships linux/darwin only).
 */
export function resolveTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  version: string = BUMBLEBEE_VERSION,
): PlatformTarget | null {
  const os =
    platform === "linux" ? "linux" : platform === "darwin" ? "darwin" : null;
  const a = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  if (!os || !a) return null;

  const assetName = `bumblebee_${version}_${os}_${a}.tar.gz`;
  const checksum = TARBALL_CHECKSUMS[assetName];
  if (!checksum) return null;

  return { os, arch: a, assetName, checksum };
}

export function sha256(data: Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** F3 — stream-hash a file on disk. Used to re-verify cached scanner binary. */
async function sha256File(filePath: string): Promise<string> {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  return new Promise((resolveHash, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function cacheParent(): string {
  return join(homedir(), ".kit", "tools", "bumblebee");
}

function cacheRoot(version = BUMBLEBEE_VERSION): string {
  return join(cacheParent(), version);
}

/**
 * Clears the cached bumblebee binary so the next scan re-downloads + re-
 * verifies. Use when a legitimate rebuild has invalidated the pinned
 * checksum, or to recover from a transient corruption. Caller is expected
 * to confirm intent — this is destructive in the sense that any modified
 * local build is lost.
 */
export async function clearBumblebeeCache(): Promise<{ removed: boolean; path: string }> {
  const path = cacheParent();
  try {
    await access(path);
  } catch {
    return { removed: false, path };
  }
  await rm(path, { recursive: true, force: true });
  return { removed: true, path };
}

export interface ScannerInstall {
  /** Path to the bumblebee executable. */
  binPath: string;
  /** Directory of *.json exposure catalogs (threat_intel). */
  catalogDir: string;
}

export interface EnsureOptions {
  /** Allow downloading the binary if it is not already cached. Default true. */
  allowDownload?: boolean;
  /** Network timeout for the download, ms. Default 120_000. */
  timeoutMs?: number;
  /** Stream to write a one-time "downloading" notice to. Default process.stderr. */
  notice?: (message: string) => void;
}

/**
 * Resolve a usable bumblebee install: an explicit override, a cached copy, or
 * a freshly downloaded-and-verified release. Returns the install on success,
 * or a human-readable `reason` when unavailable (never throws).
 */
export async function ensureBumblebee(
  opts: EnsureOptions = {},
): Promise<EnsureResult> {
  // Explicit override for users who manage their own binary/catalog.
  const envBin = process.env.KIT_BUMBLEBEE_BIN;
  if (envBin) {
    if (!(await pathExists(envBin))) {
      return {
        kind: "config",
        reason: `KIT_BUMBLEBEE_BIN points to a missing file: ${envBin}`,
      };
    }
    const catalogDir =
      process.env.KIT_BUMBLEBEE_CATALOG || join(cacheRoot(), "threat_intel");
    return { install: { binPath: envBin, catalogDir } };
  }

  const target = resolveTarget();
  if (!target) {
    return {
      kind: "unsupported",
      reason: `unsupported platform (${process.platform}/${process.arch}); bumblebee ships linux/darwin on amd64/arm64`,
    };
  }

  const root = cacheRoot();
  const binPath = join(root, "bumblebee");
  const catalogDir = join(root, "threat_intel");

  if ((await pathExists(binPath)) && (await pathExists(catalogDir))) {
    // F3 — re-verify the cached binary's SHA-256 against the pinned checksum
    // before reuse. Catches tampering or accidental corruption since download.
    try {
      const actual = await sha256File(binPath);
      if (actual !== target.checksum) {
        return {
          kind: "integrity",
          reason: `cached binary checksum mismatch (expected ${target.checksum}, got ${actual}); clear ~/.kit/tools/bumblebee and retry`,
        };
      }
    } catch (err) {
      return {
        kind: "integrity",
        reason: `cannot read cached binary for verification: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return { install: { binPath, catalogDir } };
  }

  if (opts.allowDownload === false) {
    return {
      kind: "network",
      reason:
        "scanner not cached and downloads are disabled (KIT_NO_DOWNLOAD)",
    };
  }

  try {
    const notice = opts.notice ?? ((m: string) => process.stderr.write(m + "\n"));
    notice(
      `kit: downloading supply-chain scanner bumblebee v${BUMBLEBEE_VERSION} (one-time)…`,
    );
    await downloadAndInstall(target, root, opts.timeoutMs ?? 120_000);
    return { install: { binPath, catalogDir } };
  } catch (err) {
    // A checksum mismatch is a potential tampering event — surface it distinctly
    // (callers escalate to a hard failure) rather than as a routine "unavailable".
    const isIntegrity = err instanceof IntegrityError;
    return {
      kind: isIntegrity ? "integrity" : "network",
      reason: `${isIntegrity ? "integrity check failed" : "download failed"}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function downloadAndInstall(
  target: PlatformTarget,
  root: string,
  timeoutMs: number,
): Promise<void> {
  const url = `${RELEASE_BASE_URL}/v${BUMBLEBEE_VERSION}/${target.assetName}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let buf: Buffer;
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${url}`);
    }
    // Even though the checksum below is authoritative for integrity, refuse a
    // redirect that downgraded us off HTTPS before trusting the body.
    if (!res.url.startsWith("https:")) {
      throw new Error(`refusing non-https download URL after redirects: ${res.url}`);
    }
    buf = Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }

  const digest = sha256(buf);
  if (digest !== target.checksum) {
    throw new IntegrityError(
      `checksum mismatch for ${target.assetName}: expected ${target.checksum}, got ${digest}`,
    );
  }

  // Stage inside the cache parent (same filesystem) so the final rename is
  // atomic, then swap it into place. mkdtemp gives a random suffix to avoid a
  // symlink race on a predictable staging path.
  await mkdir(cacheParent(), { recursive: true });
  const staging = await mkdtemp(join(cacheParent(), ".tmp-"));
  try {
    const tarPath = join(staging, target.assetName);
    await writeFile(tarPath, buf);
    // bumblebee tarballs extract flat: ./bumblebee, ./threat_intel/, LICENSE, README.md
    await exec("tar", ["-xzf", tarPath, "-C", staging], { timeout: 60_000 });

    const stagedBin = join(staging, "bumblebee");
    const stagedCatalog = join(staging, "threat_intel");
    if (!(await pathExists(stagedBin))) {
      throw new Error("extracted archive is missing the bumblebee binary");
    }
    if (!(await pathExists(stagedCatalog))) {
      throw new Error("extracted archive is missing threat_intel catalogs");
    }
    await chmod(stagedBin, 0o755);
    await rm(tarPath, { force: true });

    await rm(root, { recursive: true, force: true });
    await rename(staging, root);
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

export interface BumblebeeFinding {
  severity: string;
  catalogId: string;
  catalogName: string;
  ecosystem: string;
  packageName: string;
  version: string;
  sourceFile: string;
  evidence: string;
}

export interface ScanOutcome {
  /** scan_summary.status, e.g. "complete". "unknown" if no summary was seen. */
  status: string;
  timedOut: boolean;
  summarySeen: boolean;
  findings: BumblebeeFinding[];
  /** Total packages inspected (emitted + suppressed). */
  packagesScanned: number;
}

function str(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Parse bumblebee NDJSON stdout into findings + summary.
 * Blank or unparseable lines are ignored. Diagnostics (on stderr) are not seen
 * here. bumblebee exits 0 even when findings are present, so callers must judge
 * exposure from the parsed findings, never from the process exit code.
 */
export function parseScanOutput(stdout: string): ScanOutcome {
  const outcome: ScanOutcome = {
    status: "unknown",
    timedOut: false,
    summarySeen: false,
    findings: [],
    packagesScanned: 0,
  };

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (rec.record_type === "finding") {
      outcome.findings.push({
        severity: str(rec, "severity") || "unknown",
        catalogId: str(rec, "catalog_id"),
        catalogName: str(rec, "catalog_name"),
        ecosystem: str(rec, "ecosystem"),
        packageName: str(rec, "package_name") || str(rec, "normalized_name"),
        version: str(rec, "version"),
        sourceFile: str(rec, "source_file"),
        evidence: str(rec, "evidence"),
      });
    } else if (rec.record_type === "scan_summary") {
      outcome.summarySeen = true;
      outcome.status = str(rec, "status") || "unknown";
      outcome.timedOut = rec.timed_out === true;
      const emitted = num(rec.package_records_emitted);
      const suppressed = num(rec.package_records_suppressed);
      const counts = rec.counts as Record<string, unknown> | undefined;
      outcome.packagesScanned =
        emitted + suppressed || num(counts?.package);
    }
  }

  return outcome;
}

const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Highest-severity label among findings (preferring the original casing),
 * or null when there are none.
 */
export function maxSeverity(findings: BumblebeeFinding[]): string | null {
  let best: string | null = null;
  let bestRank = -1;
  for (const f of findings) {
    const rank = SEVERITY_RANK[f.severity.toLowerCase()] ?? 0;
    if (rank > bestRank) {
      bestRank = rank;
      best = f.severity;
    }
  }
  return best;
}

export interface CatalogStaleness {
  stale: boolean;
  ageDays: number;
}

/** Default age (days) after which the bundled catalogs are considered stale. */
export const CATALOG_STALE_AFTER_DAYS = 60;

/** Pure staleness check: how old the newest catalog is, and whether it crosses the threshold. */
export function isCatalogStale(
  newestMtimeMs: number,
  nowMs: number,
  thresholdDays: number = CATALOG_STALE_AFTER_DAYS,
): CatalogStaleness {
  const ageDays = Math.max(0, Math.floor((nowMs - newestMtimeMs) / 86_400_000));
  return { stale: ageDays > thresholdDays, ageDays };
}

/**
 * Newest modification time (ms) among the *.json catalogs in `dir`, or null if
 * none are found / the directory is unreadable. tar -xzf preserves the release
 * file mtimes, so this reflects when the catalogs were authored upstream.
 */
export async function newestCatalogMtime(dir: string): Promise<number | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  let newest: number | null = null;
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const s = await stat(join(dir, name));
      if (newest === null || s.mtimeMs > newest) newest = s.mtimeMs;
    } catch {
      // skip unreadable entries
    }
  }
  return newest;
}

export interface ScanRequest {
  install: ScannerInstall;
  /** bumblebee profile: baseline | project | deep. */
  profile: string;
  /** Explicit roots to scan (required for deep; optional otherwise). */
  roots: string[];
  /** Process timeout, ms. Default 120_000. */
  timeoutMs?: number;
  /** bumblebee --max-duration value (wall-clock cap). Default "90s". */
  maxDuration?: string;
}

/**
 * Run a bumblebee scan in findings-only mode against the bundled catalogs.
 * Returns the parsed outcome, or an `error` string on operational failure.
 */
export async function runScan(
  req: ScanRequest,
): Promise<{ outcome?: ScanOutcome; error?: string }> {
  const args = [
    "scan",
    "-profile",
    req.profile,
    "-exposure-catalog",
    req.install.catalogDir,
    "-findings-only",
    "-output",
    "stdout",
    "-max-duration",
    req.maxDuration ?? "90s",
  ];
  for (const root of req.roots) {
    args.push("-root", root);
  }

  try {
    const { stdout } = await exec(req.install.binPath, args, {
      timeout: req.timeoutMs ?? 120_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { outcome: parseScanOutput(stdout) };
  } catch (err) {
    // bumblebee may exit non-zero on operational error; if it still produced a
    // summary, the parsed output is authoritative.
    if (err && typeof err === "object" && "stdout" in err) {
      const outcome = parseScanOutput(String((err as { stdout?: unknown }).stdout ?? ""));
      if (outcome.summarySeen) return { outcome };
    }
    return {
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
