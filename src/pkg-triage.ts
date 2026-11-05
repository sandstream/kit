/**
 * `kit triage pkg <file.pkg>`: check a macOS installer package before it is opened. Three checks:
 * the file's SHA-256 against the publisher's own checksum list, the signing certificate's Team ID
 * against the publisher you expect, and Apple's notarization.
 *
 * The expected publisher is the protection. kit ships one entry (Node.js Foundation) and takes
 * another only from `--team-id`; a Team ID that is found but not expected is a failure, and a
 * package with no expected publisher never passes. A check that could not run says "unverified",
 * never "pass". `pkgutil` and `spctl` exist only on macOS: elsewhere the checksum runs and the
 * rest is unverified. Nothing here installs or opens the package.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename } from "node:path";

export type PkgStatus = "pass" | "fail" | "unverified";
export interface PkgCheck {
  name: "checksum" | "signature" | "notarization";
  status: PkgStatus;
  detail: string;
}
export interface PkgPublisher {
  name: string;
  teamId: string;
  filePattern: RegExp;
  shasumsUrl: (match: RegExpExecArray) => string;
}
export interface PkgReport {
  file: string;
  sha256: string;
  publisher: string | null;
  checks: PkgCheck[];
  passed: boolean;
}
export interface RunResult {
  code: number;
  out: string;
}
export interface PkgDeps {
  platform: NodeJS.Platform;
  sha256: (path: string) => Promise<string>;
  run: (cmd: string, args: string[]) => Promise<RunResult>;
  fetchText: (url: string) => Promise<string | null>;
}

/** Publishers whose Team ID kit knows. Add one only with a Team ID read from a verified package. */
export const PUBLISHERS: readonly PkgPublisher[] = [
  {
    name: "Node.js Foundation",
    teamId: "HX7739G8FX",
    filePattern: /^node-v(\d+\.\d+\.\d+)\.pkg$/,
    shasumsUrl: (m) => `https://nodejs.org/dist/v${m[1]}/SHASUMS256.txt`,
  },
];

const TEAM_ID = /^[A-Z0-9]{10}$/;

/** The hash listed for `file` in a SHASUMS-style text ("<hex>  <name>"), lowercase, or null. */
export function parseShasums(text: string, file: string): string | null {
  for (const raw of text.split("\n")) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(raw);
    if (m && m[2] === file) return m[1].toLowerCase();
  }
  return null;
}

export interface PkgSignature {
  signed: boolean;
  teamId: string | null;
  signer: string | null;
}

/**
 * Signer and Team ID from `pkgutil --check-signature`. The output starts with a `Package "…":`
 * line that holds the file's path, so the signer is read only from the lines after it, and a
 * header that does not close on its own line (a path with a line break in it) is "not signed".
 * The signer is the first certificate listed under `Certificate Chain:`.
 */
export function parsePkgSignature(out: string): PkgSignature {
  const none: PkgSignature = { signed: false, teamId: null, signer: null };
  const lines = out.split("\n");
  if (!/^Package ".*":\s*$/.test(lines[0] ?? "")) return none;
  const body = lines.slice(1);
  const statuses = body.filter((l) => /^\s+Status:/.test(l));
  if (statuses.length !== 1 || !/^\s+Status:\s+signed\b/.test(statuses[0])) return none;
  const chain = body.findIndex((l) => /^\s+Certificate Chain:\s*$/.test(l));
  if (chain < 0) return { signed: true, teamId: null, signer: null };
  const first = body
    .slice(chain + 1)
    .map((l) => /^\s+1\.\s+(.+?)\s*$/.exec(l))
    .find((m) => m);
  const signer = first ? first[1] : null;
  const id = signer ? /\(([A-Z0-9]{10})\)$/.exec(signer) : null;
  return { signed: true, teamId: id ? id[1] : null, signer };
}

/**
 * True when `spctl --assess` accepted `file` as a notarized Developer ID package. The whole
 * output must be the two lines spctl prints for it, with the path it was given, so text planted
 * in a file name cannot add a line of its own.
 */
export function parseSpctlNotarized(out: string, code: number, file: string): boolean {
  if (code !== 0) return false;
  const lines = out.trim().split("\n");
  return (
    lines.length === 2 &&
    lines[0] === `${file}: accepted` &&
    lines[1] === "source=Notarized Developer ID"
  );
}

/** The publisher entry whose file name pattern matches, or null. */
export function pickPublisher(file: string): PkgPublisher | null {
  return PUBLISHERS.find((p) => p.filePattern.test(basename(file))) ?? null;
}

export interface PkgOptions {
  sha256?: string;
  shasumsText?: string;
  teamId?: string;
}

function checksumCheck(actual: string, expected: string | null, source: string): PkgCheck {
  if (expected === null) {
    return { name: "checksum", status: "unverified", detail: `no checksum from ${source}` };
  }
  const same = expected === actual;
  return {
    name: "checksum",
    status: same ? "pass" : "fail",
    detail: same ? `matches ${source}` : `does not match ${source}: expected ${expected}`,
  };
}

function signatureCheck(sig: PkgSignature, expected: string | null, code: number): PkgCheck {
  const name = "signature";
  if (code !== 0) return { name, status: "fail", detail: `pkgutil exited with status ${code}` };
  if (!sig.signed) return { name, status: "fail", detail: "the package is not signed" };
  if (!sig.teamId) return { name, status: "fail", detail: `no Team ID in signer "${sig.signer}"` };
  if (expected === null) {
    const d = `signed by ${sig.teamId}, but no expected publisher was named (use --team-id)`;
    return { name, status: "unverified", detail: d };
  }
  const ok = sig.teamId === expected;
  const detail = ok
    ? `${sig.signer}`
    : `Team ID ${sig.teamId} is not the expected ${expected} (${sig.signer})`;
  return { name, status: ok ? "pass" : "fail", detail };
}

async function expectedChecksum(
  report: { file: string; pub: PkgPublisher | null },
  opts: PkgOptions,
  deps: PkgDeps,
): Promise<{ hash: string | null; source: string }> {
  const file = basename(report.file);
  if (opts.sha256) return { hash: opts.sha256.toLowerCase(), source: "--checksum" };
  if (opts.shasumsText !== undefined) {
    return { hash: parseShasums(opts.shasumsText, file), source: "--checksum" };
  }
  const m = report.pub ? report.pub.filePattern.exec(file) : null;
  if (!report.pub || !m) return { hash: null, source: "the command line (none given)" };
  const url = report.pub.shasumsUrl(m);
  const text = await deps.fetchText(url);
  return { hash: text === null ? null : parseShasums(text, file), source: url };
}

/** Line breaks and other control characters: the tools print the path, so these let a name plant lines. */
export const UNSAFE_PATH = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function refused(file: string): PkgReport {
  const detail = "the path contains a line break or control character; rename the file";
  const checks = (["checksum", "signature", "notarization"] as const).map((name) => ({
    name,
    status: "fail" as const,
    detail,
  }));
  return { file: JSON.stringify(file), sha256: "", publisher: null, checks, passed: false };
}

/** Run the three checks. Never throws on a failed tool: that becomes "unverified". */
export async function triagePkg(file: string, opts: PkgOptions, deps: PkgDeps): Promise<PkgReport> {
  if (UNSAFE_PATH.test(file)) return refused(file);
  const pub = pickPublisher(file);
  const teamId = opts.teamId ?? pub?.teamId ?? null;
  const sha256 = await deps.sha256(file);
  const want = await expectedChecksum({ file, pub }, opts, deps);
  const checks: PkgCheck[] = [checksumCheck(sha256, want.hash, want.source)];
  if (deps.platform !== "darwin") {
    for (const name of ["signature", "notarization"] as const) {
      checks.push({ name, status: "unverified", detail: "needs macOS (pkgutil, spctl)" });
    }
  } else {
    const sig = await deps.run("/usr/sbin/pkgutil", ["--check-signature", file]);
    checks.push(signatureCheck(parsePkgSignature(sig.out), teamId, sig.code));
    const spctl = await deps.run("/usr/sbin/spctl", ["--assess", "--type", "install", "-v", file]);
    const ok = parseSpctlNotarized(spctl.out, spctl.code, file);
    checks.push({
      name: "notarization",
      status: ok ? "pass" : "fail",
      detail: ok
        ? "accepted, source=Notarized Developer ID"
        : "spctl did not accept it as notarized",
    });
  }
  if (deps.platform === "darwin" && (await deps.sha256(file)) !== sha256) {
    // pkgutil and spctl take a path, so the file could change between the hash and the tools.
    const detail = "the file changed while it was checked";
    for (const c of checks) Object.assign(c, { status: "fail", detail });
  }
  const passed = checks.every((c) => c.status === "pass");
  return { file, sha256, publisher: pub?.name ?? null, checks, passed };
}

/** True for a Team ID in the form Apple issues (ten capitals or digits). */
export const isTeamId = (s: string): boolean => TEAM_ID.test(s);

export const defaultPkgDeps: PkgDeps = {
  platform: process.platform,
  sha256: (path) =>
    new Promise((resolve, reject) => {
      const h = createHash("sha256");
      createReadStream(path)
        .on("data", (d) => h.update(d))
        .on("error", reject)
        .on("end", () => resolve(h.digest("hex")));
    }),
  run: (cmd, args) =>
    new Promise((resolve) => {
      execFile(cmd, args, { timeout: 60_000, maxBuffer: 1_000_000 }, (err, stdout, stderr) => {
        const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
        resolve({ code, out: `${stdout}${stderr}` });
      });
    }),
  fetchText: async (url) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      const text = res.ok ? await res.text() : null;
      return text !== null && text.length <= 2_000_000 ? text : null;
    } catch {
      return null;
    }
  },
};
