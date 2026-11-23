import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  isOtherScannerFormat,
  reportText,
  scannerEvidence,
  scannerGap,
  scannerRecord,
  type ScannerGap,
  type ScannerReport,
} from "./check-scanner-evidence.js";
import type { SecurityCheckResult } from "./check-security.js";
import { readRegularFileBytesIfPresent } from "./upstream-safe-read.js";
import { execFileNoThrow, type ExecResult } from "./utils/execFileNoThrow.js";
import { resolveToolBin } from "./utils/resolveTool.js";

const BASE = { category: "dependency", name: "pip-audit" } as const;
const PACKAGE_NAME = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;
const PIN = /^[ \t]*([a-z0-9._-]+)[ \t]*==[ \t]*([^ \t]+)[ \t]*$/i;
// PEP 440 spellings accepted by packaging.version.Version in the static collector.
const VERSION = new RegExp(
  "^v?(?:(?<epoch>[0-9]+)!)?(?<release>[0-9]+(?:\\.[0-9]+)*)" +
    "(?:[._-]?(?<pre>alpha|a|beta|b|preview|pre|c|rc)[._-]?(?<preNum>[0-9]+)?)?" +
    "(?:-(?<postNum>[0-9]+)|[._-]?(?<post>post|rev|r)[._-]?(?<postLabelNum>[0-9]+)?)?" +
    "(?:[._-]?(?<dev>dev)[._-]?(?<devNum>[0-9]+)?)?" +
    "(?:\\+(?<local>[a-z0-9]+(?:[._-][a-z0-9]+)*))?$",
  "i",
);
const PRE_RELEASE: Record<string, string> = {
  alpha: "a",
  beta: "b",
  preview: "rc",
  pre: "rc",
  c: "rc",
};
const UNSUPPORTED_PIN =
  "only flat name==version pins are supported, without options, URLs, extras or markers";
const MAX_VERSION_LENGTH = 1024;

type Pins = Map<string, string>;
type Affected = { name: string; version: string }[];

interface PipReport extends ScannerReport {
  affected: Affected;
}

function normalizedName(name: unknown): string | undefined {
  if (typeof name !== "string" || !PACKAGE_NAME.test(name)) return undefined;
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

function decimal(digits: string): string {
  return digits.replace(/^0+(?=[0-9])/, "");
}

function normalizedVersionSuffix(parts: Record<string, string>): string {
  let suffix = "";
  const pre = parts.pre?.toLowerCase();
  if (pre) suffix += (PRE_RELEASE[pre] ?? pre) + decimal(parts.preNum ?? "0");
  if (parts.post || parts.postNum)
    suffix += `.post${decimal(parts.postNum ?? parts.postLabelNum ?? "0")}`;
  if (parts.dev) suffix += `.dev${decimal(parts.devNum ?? "0")}`;
  if (parts.local) suffix += `+${parts.local.split(/[._-]/).map(normalizeLocalPart).join(".")}`;
  return suffix.toLowerCase();
}

function normalizedVersion(version: unknown): string | undefined {
  // Bound work on individual versions and keep numeric parts below Python's integer input limit.
  if (typeof version !== "string" || version.length > MAX_VERSION_LENGTH) return undefined;
  const parts = VERSION.exec(version)?.groups;
  if (!parts) return undefined;
  const epoch = decimal(parts.epoch ?? "0");
  const release = parts.release.split(".").map(decimal).join(".");
  const prefix = epoch === "0" ? release : `${epoch}!${release}`;
  const normalized = prefix + normalizedVersionSuffix(parts);
  return normalized.length <= MAX_VERSION_LENGTH ? normalized : undefined;
}

function normalizeLocalPart(part: string): string {
  return /^[0-9]+$/.test(part) ? decimal(part) : part;
}

function parsePins(text: string): Pins | string {
  // Reject control characters and nonstandard line breaks before ignoring any comments.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u2028\u2029\ufeff]/.test(text))
    return "requirements.txt contains unsupported control characters";
  const lines = text.split(/\r\n|\r|\n/);
  const pins: Pins = new Map();
  for (const [index, raw] of lines.entries()) {
    const location = `requirements.txt line ${index + 1}`;
    const encoding = index < 2 && /^[ \t]*#.*?coding[:=][ \t]*([\w.-]+)/.exec(raw)?.[1];
    if (encoding && !/^utf[-_]8$/i.test(encoding)) return `${location}: unsupported text encoding`;
    if (/\\[ \t]*$/.test(raw)) return `${location}: line continuations are unsupported`;
    const line = raw.replace(/(?:^|[ \t])#.*$/, "");
    if (/^[ \t]*$/.test(line)) continue;
    const match = PIN.exec(line);
    const name = normalizedName(match?.[1]);
    const version = normalizedVersion(match?.[2]);
    if (!name || !version) return `${location}: ${UNSUPPORTED_PIN}`;
    const previous = pins.get(name);
    if (previous !== undefined && previous !== version)
      return `${location}: conflicting exact pins`;
    pins.set(name, version);
  }
  return pins;
}

function readVulnerabilities(vulns: unknown[], ids: Set<string>): boolean {
  let valid = true;
  for (const vuln of vulns) {
    if (
      !scannerRecord(vuln) ||
      !reportText(vuln.id) ||
      !Array.isArray(vuln.fix_versions) ||
      !vuln.fix_versions.every((version: unknown) => normalizedVersion(version) !== undefined)
    ) {
      valid = false;
      continue;
    }
    ids.add(vuln.id);
  }
  return valid;
}

function matchDependency(dep: Record<string, unknown>, pins: Pins) {
  const name = normalizedName(dep.name);
  const version = normalizedVersion(dep.version);
  if (!name || !version || pins.get(name) !== version || !Array.isArray(dep.vulns))
    return undefined;
  const vulns: unknown[] = dep.vulns;
  return { name, vulns };
}

function readInventory(dependencies: unknown[], pins: Pins): PipReport {
  const seen = new Map<string, Set<string>>();
  let partial = false;
  let skipped = false;
  for (const dep of dependencies) {
    if (!scannerRecord(dep)) {
      partial = true;
      continue;
    }
    if (Object.hasOwn(dep, "skip_reason")) {
      skipped = true;
      continue;
    }
    const match = matchDependency(dep, pins);
    if (!match) {
      partial = true;
      continue;
    }
    const { name, vulns } = match;
    const previous = seen.get(name);
    const ids = previous ?? new Set<string>();
    if (!readVulnerabilities(vulns, ids) || previous) partial = true;
    seen.set(name, ids);
  }

  const affected: Affected = [];
  let count = 0;
  for (const [name, version] of pins) {
    const found = seen.get(name)?.size ?? 0;
    if (found > 0) affected.push({ name, version });
    count += found;
  }
  if (skipped)
    return { count, affected, gap: "partial", note: "pip-audit returned skipped dependencies" };
  if (partial || seen.size !== pins.size)
    return {
      count,
      affected,
      gap: "partial",
      note: "pip-audit report did not match the exact pin inventory or contained invalid records",
    };
  return { count, affected };
}

function readReport(stdout: string, pins: Pins): PipReport {
  const empty = { count: 0, affected: [] };
  const malformed = { ...empty, gap: "malformed" } as const;
  if (!stdout.trim()) return { ...empty, gap: "missing", note: "pip-audit produced no report" };
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return malformed;
  }
  if (Array.isArray(doc)) return { ...empty, gap: "unsupported" };
  if (!scannerRecord(doc)) return malformed;
  if (isOtherScannerFormat(doc)) return { ...empty, gap: "unsupported" };
  if (!Array.isArray(doc.dependencies)) return malformed;

  const report = readInventory(doc.dependencies, pins);
  // pip-audit only populates fixes when invoked with --fix.
  if (!Array.isArray(doc.fixes) || doc.fixes.length !== 0)
    return {
      ...report,
      gap: report.count ? "partial" : "malformed",
      note: "pip-audit report did not contain an empty fixes array",
    };
  if (doc.dependencies.length === 0)
    return { ...empty, gap: "missing", note: "pip-audit returned no rows for the declared pins" };
  return report;
}

function evidence(row: SecurityCheckResult, count: number, gap?: ScannerGap): SecurityCheckResult {
  const result = scannerEvidence(row, count, gap);
  // The pip-audit JSON format supplies no severity.
  delete result.severity;
  return result;
}

function unverified(status: ScannerGap["status"], reason: string): SecurityCheckResult {
  return evidence({ ...BASE, status: "warn", detail: "" }, 0, {
    status,
    reason,
    didNotStart: true,
  });
}

function inputChanged(path: string, bytes: Buffer): boolean {
  try {
    const current = readRegularFileBytesIfPresent(path);
    return current === null || !bytes.equals(current);
  } catch {
    return true;
  }
}

function classify(report: PipReport, run: ExecResult, stale: boolean): SecurityCheckResult {
  const { count, affected } = report;
  let gap = scannerGap(report, run, { findings: 1 });
  if (!gap && run.ok && count > 0)
    gap = { status: "partial", reason: "pip-audit exit status disagrees with its findings" };
  const row: SecurityCheckResult = {
    ...BASE,
    status: "pass",
    detail: "no known vulnerabilities in declared Python pins",
  };
  if (count > 0) {
    row.status = "fail";
    row.detail = `${count} known ${count === 1 ? "vulnerability" : "vulnerabilities"} in ${affected.length} pinned ${affected.length === 1 ? "package" : "packages"}`;
    row.affected = affected;
    row.hasFindings = true;
  }
  if (!gap && stale) {
    const result = evidence(row, count, {
      status: "partial",
      reason: "requirements.txt changed during the audit",
    });
    return { ...result, evidenceStatus: "stale" };
  }
  return evidence(row, count, gap);
}

function auditEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Keep Python startup paths and pip-api's interpreter override out of this invocation.
  for (const key of Object.keys(env)) {
    if (/^(?:PYTHONPATH|PYTHONHOME|PIPAPI_PYTHON_LOCATION)$/i.test(key)) delete env[key];
  }
  return env;
}

async function runAudit(pins: Pins, tools: typeof defaultTools): Promise<ExecResult | null> {
  const dir = await mkdtemp(join(tmpdir(), "kit-pip-audit-"));
  try {
    const env = auditEnv();
    const bin = await tools.resolveToolBin("pip-audit", {
      env,
      platform: process.platform,
      // The mise shim version probe also starts Python. Give it the same safe working directory.
      exec: (command, args, options) =>
        tools.execFileNoThrow(
          command,
          args,
          args[0] === "--version" ? { ...options, cwd: dir, env } : options,
        ),
    });
    if (!bin || !isAbsolute(bin)) return null;
    const snapshot = join(dir, "requirements.txt");
    const contents = Array.from(pins, ([name, version]) => `${name}==${version}\n`).join("");
    await writeFile(snapshot, contents, { flag: "wx", mode: 0o600 });
    // An explicit cache directory avoids pip-audit's default `pip cache dir` subprocess.
    return await tools.execFileNoThrow(
      bin,
      [
        "-r",
        snapshot,
        "--no-deps",
        "--disable-pip",
        "--format=json",
        "--progress-spinner=off",
        "--cache-dir",
        join(dir, "cache"),
      ],
      { cwd: dir, env, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

const defaultTools = { resolveToolBin, execFileNoThrow };

export async function checkPipAudit(
  root: string,
  tools = defaultTools,
): Promise<SecurityCheckResult> {
  const path = resolve(root, "requirements.txt");
  let bytes: Buffer | null;
  try {
    bytes = readRegularFileBytesIfPresent(path);
  } catch {
    return unverified(
      "unavailable",
      "requirements.txt could not be read as a bounded regular file",
    );
  }
  if (bytes === null) return { ...BASE, status: "skip", detail: "no requirements.txt found" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return unverified("unsupported", "requirements.txt is not valid UTF-8");
  }
  const pins = parsePins(text);
  if (typeof pins === "string") return unverified("unsupported", pins);
  if (pins.size === 0)
    return evidence(
      { ...BASE, status: "pass", detail: "requirements.txt declares no dependencies" },
      0,
    );

  let run: ExecResult | null;
  try {
    run = await runAudit(pins, tools);
  } catch {
    return unverified("unavailable", "pip-audit could not use its private requirements snapshot");
  }
  if (!run) return unverified("unavailable", "pip-audit is not installed or could not be located");
  return classify(readReport(run.stdout, pins), run, inputChanged(path, bytes));
}
