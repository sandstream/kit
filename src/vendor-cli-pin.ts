/**
 * Vendor-CLI identity pin: the vault, cloud and deploy CLIs kit hands secrets or credentials
 * through (`PINNABLE_CLIS`) are pinned by the file they resolve to,
 * its SHA-256 and the version it reported, and kit refuses to run a pinned CLI that no longer
 * matches (kit-research#232: 1Password's November 2026 incident reached the vendor's git and
 * CI/CD, and kit ran whichever `op` came first on PATH).
 *
 * Where the pin lives: `.kit/cli-lock.json`, the lock kit already commits for CLI versions, under
 * a top-level `identity` map: tool → `<platform>-<arch>` → identity. A team shares it; each
 * platform has its own hash because each ships its own binary. A path under the home directory
 * is stored as `~/…` so the committed lock does not carry a username.
 *
 * What this proves: the binary is the one someone on the team accepted. It does NOT prove the
 * vendor built it — vendor signatures (codesign, Authenticode, gpg) differ per OS and are a manual
 * step (docs/THREAT_MODEL.md).
 *
 * One resolver: every call resolves the CLI the same way, mise first, then PATH
 * (`resolvePinnedLaunch`), pinned or not, so the file the pin measures is the file each call runs and
 * two calls to one tool (`op whoami`, `op read`) can never start two different binaries.
 *
 * Use time (`execPinned`): resolve, realpath, hash (once per process per file), compare. A pinned
 * CLI whose file or hash differs is never run — not even with `--version`, since that would execute
 * the unverified file — and there is no fallback to the bare name. The only way to re-trust is
 * `kit tools pin --accept <tool>`, which writes an audit row.
 *
 * Windows npm shims: an npm-installed CLI (`vercel`, `eas`, `wrangler`, …) resolves to a `.cmd`
 * shim that `execFile` cannot start without a shell. kit never adds a shell: it reads the shim
 * (`utils/win-npm-shim.ts`), runs the file the shim names with kit's own `process.execPath` (or the
 * `.exe` itself), and pins that file plus the shim's own hash. A shim kit cannot read is refused.
 * All of this is win32-only; on POSIX the resolved file is run as before.
 */
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, realpathSync, type BigIntStats } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { readCliLock, writeCliLock, type CliIdentity } from "./lock.js";
import { exec } from "./utils/exec.js";
import { execFileNoThrow } from "./utils/execFileNoThrow.js";
import { findOnPath } from "./utils/path-lookup.js";
import { failCall } from "./utils/call-scope.js";
import { identityOf, sameIdentity } from "./utils/same-file.js";
import { isBatchFile, parseNpmShim, shimTargetPath } from "./utils/win-npm-shim.js";
import { vaultToolFor } from "./vault-tool.js";

export type { CliIdentity };

/** Secret sources whose CLI `vaultToolFor` (the login map) does not cover. */
const EXTRA_SOURCE_CLIS: Readonly<Record<string, string>> = {
  "gcp-sm": "gcloud",
  "azure-kv": "az",
  eas: "eas",
  dotenvx: "dotenvx",
};

/**
 * Every CLI the pin covers: the secret backends' CLIs (`eas` and `dotenvx` are backends too),
 * `gh` (`secrets sync` hands it values), and the deploy CLIs kit pushes secrets through
 * (`secrets propagate`) or reads deploy credentials with (`vercel`, `supabase`, `fly`/`flyctl`, `railway`,
 * `wrangler`; `stripe config --list` prints API keys).
 */
export const PINNABLE_CLIS: readonly string[] = [
  "op",
  "infisical",
  "bw",
  "doppler",
  "vault",
  "aws",
  "gcloud",
  "az",
  "gh",
  "eas",
  "dotenvx",
  "vercel",
  "supabase",
  "fly",
  "flyctl",
  "railway",
  "wrangler",
  "stripe",
];

function cliForSource(source: string | undefined): string | null {
  if (source === undefined) return null;
  return (
    vaultToolFor(source) ??
    (Object.hasOwn(EXTRA_SOURCE_CLIS, source) ? EXTRA_SOURCE_CLIS[source]! : null)
  );
}

/** The vendor CLIs this project's `[secrets]` resolves through, sorted. */
export function projectVendorClis(secrets: {
  store?: string;
  keys?: Record<string, { source?: string }>;
}): string[] {
  const out = new Set<string>();
  const add = (s: string | undefined) => {
    const tool = cliForSource(s);
    if (tool) out.add(tool);
  };
  add(secrets.store);
  for (const k of Object.values(secrets.keys ?? {})) add(k.source);
  return [...out].sort();
}

export interface PinDeps {
  cwd: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  arch: string;
  home: string;
  /** `mise which <tool>`, the resolver `execCli` has always used first. Null when mise has none. */
  miseWhich: (tool: string) => Promise<string | null>;
}

async function realMiseWhich(tool: string): Promise<string | null> {
  const r = await execFileNoThrow("mise", ["which", tool], { timeout: 8_000 });
  const line = r.ok ? r.stdout.trim().split("\n")[0]?.trim() : "";
  return line && isAbsolute(line) && identityOf(line) ? line : null;
}

export function defaultPinDeps(cwd: string = process.cwd()): PinDeps {
  return {
    cwd,
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    home: homedir(),
    miseWhich: realMiseWhich,
  };
}

export function platformKey(deps: Pick<PinDeps, "platform" | "arch">): string {
  return `${deps.platform}-${deps.arch}`;
}

/** A realpath as stored in the committed lock: `~/…` (forward slashes) under home, else as-is. */
export function portablePath(real: string, home: string): string {
  const rel = relative(home, real);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return `~/${rel.split(sep).join("/")}`;
  return real;
}

export function expandPath(stored: string, home: string): string {
  return stored.startsWith("~/") ? join(home, ...stored.slice(2).split("/")) : stored;
}

/**
 * Same file? By bigint device + inode when both exist (no string compare, survives case and
 * symlink differences), else by path, case-folded on win32 and darwin (case-insensitive by default).
 */
export function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const ia: BigIntStats | undefined = identityOf(a);
  const ib: BigIntStats | undefined = identityOf(b);
  // An id of 0 (some Windows filesystems) proves nothing either way: fall through to the path.
  if (ia && ib && ia.ino !== 0n && ib.ino !== 0n) return sameIdentity(ia, ib);
  const fold = platform === "win32" || platform === "darwin";
  return fold ? relative(a.toLowerCase(), b.toLowerCase()) === "" : relative(a, b) === "";
}

// ── hashing, once per process per file ───────────────────────────────────────────────────────────

const hashCache = new Map<string, { stamp: string; sha256: string; size: number }>();
let hashCount = 0;

function stampOf(st: BigIntStats): string {
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}`;
}

/** SHA-256 of a file's bytes. Re-reads only when the file's id, size or mtime changed. */
async function hashFile(path: string): Promise<{ sha256: string; size: number }> {
  const st = identityOf(path);
  if (!st) throw new Error(`cannot stat ${path}`);
  const hit = hashCache.get(path);
  if (hit && hit.stamp === stampOf(st)) return hit;
  const hash = createHash("sha256");
  await new Promise<void>((resolveP, rejectP) => {
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", rejectP)
      .on("end", () => resolveP());
  });
  hashCount++;
  const entry = { stamp: stampOf(st), sha256: hash.digest("hex"), size: Number(st.size) };
  hashCache.set(path, entry);
  return entry;
}

/** Test seam: how many times a file was actually read for hashing in this process. */
export function _hashReads(): number {
  return hashCount;
}

export function _resetHashCacheForTests(): void {
  hashCache.clear();
  hashCount = 0;
}

// ── resolve + measure ────────────────────────────────────────────────────────────────────────────

/** What to `execFile`: `file` with `prefix` before the caller's arguments. Never a shell. */
export interface Launch {
  file: string;
  prefix: string[];
}

export interface Measured {
  /** The file kit would start (mise's answer, else the first PATH hit). */
  resolved: string;
  /**
   * Its realpath: a Homebrew `/usr/local/bin/op` symlink hashes its Cellar/Caskroom target. For a
   * win32 npm shim, the realpath of the program the shim starts (its JS entry or `.exe`).
   */
  realpath: string;
  sha256: string;
  size: number;
  /** Win32 npm shim only: the shim's realpath and the SHA-256 of the bytes kit parsed. */
  shim?: { path: string; sha256: string };
  /** How kit runs exactly the file it hashed. */
  launch: Launch;
}

/** A win32 `.cmd` shim kit cannot turn into a direct `execFile`; never retried through a shell. */
export class ShimUnreadable extends Error {
  constructor(shim: string, reason: string) {
    super(
      `kit cannot run ${shim}: it is a Windows batch shim kit could not read (${reason}). ` +
        `kit runs vendor CLIs without a shell and will not fall back to one. ` +
        `Install the CLI as an .exe, or reinstall it with npm, pnpm or yarn so the shim has a known form.`,
    );
    this.name = "ShimUnreadable";
  }
}

/** Parse a win32 shim from the very bytes that are hashed, and measure the file it starts. */
async function measureShim(resolved: string, shimReal: string): Promise<Measured> {
  const bytes = readFileSync(shimReal);
  const parsed = parseNpmShim(bytes.toString("utf8"));
  if (!parsed.ok) throw new ShimUnreadable(shimReal, parsed.reason);
  const target = shimTargetPath(parsed.target, dirname(shimReal), join);
  let entry: string;
  try {
    entry = realpathSync.native(target);
  } catch {
    throw new ShimUnreadable(shimReal, `the file it starts, ${target}, does not exist`);
  }
  const { sha256, size } = await hashFile(entry);
  const shimSha = createHash("sha256").update(bytes).digest("hex");
  const launch =
    parsed.target.runner === "node"
      ? { file: process.execPath, prefix: [entry] }
      : { file: entry, prefix: [] };
  return {
    resolved,
    realpath: entry,
    sha256,
    size,
    shim: { path: shimReal, sha256: shimSha },
    launch,
  };
}

function isWinShim(real: string, deps: Pick<PinDeps, "platform">): boolean {
  return deps.platform === "win32" && isBatchFile(real);
}

async function resolveVendorCli(tool: string, deps: PinDeps): Promise<string | null> {
  return (await deps.miseWhich(tool)) ?? findOnPath(tool, deps.env, deps.platform, deps.cwd);
}

/** Resolve and hash `tool` without running it. Null when it is not installed. */
export async function measureCli(tool: string, deps: PinDeps): Promise<Measured | null> {
  const resolved = await resolveVendorCli(tool, deps);
  if (!resolved) return null;
  const real = realpathSync.native(resolved);
  if (isWinShim(real, deps)) return measureShim(resolved, real);
  const { sha256, size } = await hashFile(real);
  return { resolved, realpath: real, sha256, size, launch: { file: real, prefix: [] } };
}

/** Run `<bin> --version` and take the first version token, the way `kit tools list` reads it. */
export async function readCliVersion(bin: string | Launch): Promise<string | null> {
  const l = typeof bin === "string" ? { file: bin, prefix: [] } : bin;
  const r = await execFileNoThrow(l.file, [...l.prefix, "--version"], { timeout: 10_000 });
  if (!r.ok) return null;
  const m = (r.stdout || r.stderr || "").match(/(\d+[\d.]*)/);
  return m ? m[1]! : null;
}

// ── the lock ─────────────────────────────────────────────────────────────────────────────────────

export async function readPin(tool: string, deps: PinDeps): Promise<CliIdentity | null> {
  const lock = await readCliLock(deps.cwd);
  return lock?.identity?.[tool]?.[platformKey(deps)] ?? null;
}

/** Every pinned tool, with the platforms it is pinned for. */
export async function readAllPins(
  cwd: string,
): Promise<Record<string, Record<string, CliIdentity>>> {
  return (await readCliLock(cwd))?.identity ?? {};
}

export async function writePin(tool: string, id: CliIdentity, deps: PinDeps): Promise<void> {
  const lock = (await readCliLock(deps.cwd)) ?? { version: 1, tools: {} };
  const identity = { ...(lock.identity ?? {}) };
  identity[tool] = { ...(identity[tool] ?? {}), [platformKey(deps)]: id };
  await writeCliLock({ ...lock, identity }, deps.cwd);
}

export function identityFrom(m: Measured, version: string, home: string): CliIdentity {
  return {
    path: portablePath(m.realpath, home),
    sha256: m.sha256,
    version,
    size: m.size,
    pinnedAt: new Date().toISOString(),
    ...(m.shim ? { shim: { path: portablePath(m.shim.path, home), sha256: m.shim.sha256 } } : {}),
  };
}

/** Same shim, or no shim on either side. A shim that appeared, vanished or changed is not. */
export function sameShim(
  pin: CliIdentity,
  m: Measured,
  deps: Pick<PinDeps, "home" | "platform">,
): boolean {
  if (!pin.shim || !m.shim) return !pin.shim && !m.shim;
  return (
    pin.shim.sha256 === m.shim.sha256 &&
    samePath(expandPath(pin.shim.path, deps.home), m.shim.path, deps.platform)
  );
}

// ── use time ─────────────────────────────────────────────────────────────────────────────────────

type Reason = "missing" | "moved" | "hash" | "shim";

export type UseVerdict =
  | { ok: true; measured: Measured | null; pinned: boolean }
  | {
      ok: false;
      reason: Reason;
      pin: CliIdentity;
      measured: Measured | null;
    };

/** Pure: a measured binary against its pin. No pin → allowed, unpinned (the check row warns). */
function judgeUse(
  pin: CliIdentity | null,
  m: Measured | null,
  deps: Pick<PinDeps, "home" | "platform">,
): UseVerdict {
  if (!pin) return { ok: true, measured: m, pinned: false };
  if (!m) return { ok: false, reason: "missing", pin, measured: null };
  if (!samePath(expandPath(pin.path, deps.home), m.realpath, deps.platform)) {
    return { ok: false, reason: "moved", pin, measured: m };
  }
  if (pin.sha256 !== m.sha256) return { ok: false, reason: "hash", pin, measured: m };
  if (!sameShim(pin, m, deps)) return { ok: false, reason: "shim", pin, measured: m };
  return { ok: true, measured: m, pinned: true };
}

export class VendorCliPinRefusal extends Error {
  constructor(
    readonly tool: string,
    message: string,
  ) {
    super(message);
    this.name = "VendorCliPinRefusal";
  }
}

const WHY: Record<Reason, string> = {
  missing: "it is pinned but no longer found",
  moved: "it now resolves to a different file than the pinned one (PATH shadowing?)",
  hash: "its SHA-256 differs from the pin",
  shim: "its Windows .cmd shim differs from the pinned one (edited to start something else?)",
};

function refusalMessage(tool: string, v: Extract<UseVerdict, { ok: false }>, key: string): string {
  const actual = v.measured ? `${v.measured.realpath}  sha256 ${v.measured.sha256}` : "(not found)";
  const shims =
    v.reason === "shim"
      ? [
          `  pinned shim: ${v.pin.shim ? `${v.pin.shim.path}  sha256 ${v.pin.shim.sha256}` : "(none)"}`,
          `  actual shim: ${v.measured?.shim ? `${v.measured.shim.path}  sha256 ${v.measured.shim.sha256}` : "(none)"}`,
        ]
      : [];
  return [
    `kit refused to run ${tool}: ${WHY[v.reason]} (.kit/cli-lock.json, ${key}).`,
    `  expected: ${v.pin.path}  sha256 ${v.pin.sha256}  (version ${v.pin.version})`,
    `  actual:   ${actual}`,
    ...shims,
    `  kit did not run it and will not fall back to another ${tool}.`,
    `  See whether only the version changed: kit check --category security`,
    `  If you trust this binary, accept it (audited): kit tools pin --accept ${tool}`,
  ].join("\n");
}

const announced = new Set<string>();

/** Print a refusal once per process, fail the call, and throw it. */
function refuse(tool: string, msg: string, once: string): never {
  if (!announced.has(once)) {
    announced.add(once);
    process.stderr.write(msg + "\n");
  }
  failCall(msg);
  throw new VendorCliPinRefusal(tool, msg);
}

/** `measureCli`, with an unreadable win32 shim turned into a refusal for `tool`. */
async function measureOrRefuse(tool: string, deps: PinDeps): Promise<Measured | null> {
  try {
    return await measureCli(tool, deps);
  } catch (err) {
    if (!(err instanceof ShimUnreadable)) throw err;
    return refuse(tool, `kit refused to run ${tool}: ${err.message}`, `${tool}\0${err.message}`);
  }
}

/** The verified measurement of a pinned `tool`, null when unpinned, or a `VendorCliPinRefusal`. */
async function verifiedPinned(tool: string, deps: PinDeps): Promise<Measured | null> {
  const pin = await readPin(tool, deps);
  if (!pin) return null;
  const m = await measureOrRefuse(tool, deps);
  const v = judgeUse(pin, m, deps);
  if (v.ok) return v.measured;
  const once = `${tool}\0${v.measured?.realpath ?? ""}\0${v.measured?.sha256 ?? ""}\0${v.measured?.shim?.sha256 ?? ""}`;
  return refuse(tool, refusalMessage(tool, v, platformKey(deps)), once);
}

/**
 * The verified file to run for a pinned `tool`, null when `tool` is unpinned (the caller keeps
 * its own resolution), or a `VendorCliPinRefusal`. A refusal is printed to stderr once per
 * process and fails the call (`failCall`): the CLI exits non-zero, so a caller that swallows the
 * throw (most backends turn errors into "not found") still fails with the reason on screen; in the
 * MCP server it is that tool call's error and leaves the server's exit code alone.
 */
export async function assertPinnedCli(
  tool: string,
  deps: PinDeps = defaultPinDeps(),
): Promise<string | null> {
  return (await verifiedPinned(tool, deps))?.realpath ?? null;
}

/**
 * How a call to `tool` starts: the verified file when pinned (or a `VendorCliPinRefusal`), else
 * what the pin's own resolver finds (mise first, then PATH), else the bare name. On win32 an npm
 * `.cmd` shim becomes `node <entry>` (or the `.exe` it names); one kit cannot read is refused.
 * Use this for every spawn of a pinnable CLI, so the pin measures exactly what runs.
 */
export async function resolvePinnedLaunch(
  tool: string,
  cwd: string = process.cwd(),
  deps: PinDeps = defaultPinDeps(cwd),
): Promise<Launch> {
  const pinned = await verifiedPinned(tool, deps);
  if (pinned) return pinned.launch;
  const resolved = await resolveVendorCli(tool, deps);
  if (!resolved) return { file: tool, prefix: [] };
  if (deps.platform !== "win32" || !isBatchFile(realpathSync.native(resolved))) {
    return { file: resolved, prefix: [] };
  }
  return (await measureOrRefuse(tool, deps))!.launch;
}

/** `exec(tool, args, opts)` behind the pin, resolved by `resolvePinnedLaunch`. Never a fallback. */
export async function execPinned(
  tool: string,
  args: string[],
  opts?: Parameters<typeof exec>[2],
): Promise<{ stdout: string; stderr: string }> {
  const cwd = typeof opts?.cwd === "string" ? opts.cwd : process.cwd();
  const l = await resolvePinnedLaunch(tool, cwd);
  return exec(l.file, [...l.prefix, ...args], opts) as Promise<{ stdout: string; stderr: string }>;
}
