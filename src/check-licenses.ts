import { access } from "node:fs/promises";
import { resolve } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";
import { execFileNoThrow, failedDetail, type ExecResult } from "./utils/execFileNoThrow.js";
import { redactSecrets } from "./utils/redactSecrets.js";
import { resolveToolBin } from "./utils/resolveTool.js";

const PROBLEMATIC_LICENSES = ["GPL", "AGPL", "LGPL", "CPAL", "OSL", "EUPL"];
const BASE = { category: "supply-chain", name: "license check" } as const;

function unavailable(): SecurityCheckResult {
  return {
    ...BASE,
    status: "warn",
    detail: "license-checker not installed or not executable",
    severity: "low",
    suggestion: "Install license-checker through a triaged tool declaration, then re-run",
    didNotRun: true,
  };
}

function failureReason(result: ExecResult): string {
  const lines = `${result.stderr}\n${result.stdout}`.split(/\r?\n/).map((line) => line.trim());
  const diagnostic = lines.find(
    (line) =>
      /^(?:npm\s+)?(?:error|err!?|fatal)\b/i.test(line) ||
      /^(?:[A-Za-z]+Error(?:\s+\[[A-Z_]+\])?:|E[A-Z][A-Z0-9_]+\b|permission denied\b)/.test(line),
  );
  const fallback = lines.find((line) => line && !/^(?:npm\s+)?warn(?:ing)?\b/i.test(line));
  return redactSecrets(diagnostic ?? fallback ?? lines.find(Boolean) ?? "").slice(0, 200);
}

function failure(result: ExecResult, invalidJson = false): SecurityCheckResult {
  const reason = failureReason(result);
  const base = invalidJson
    ? "license check failed: scanner output is not a valid license report"
    : `license check failed (exit ${result.exitCode})${reason ? `: ${reason}` : ""}`;
  return {
    ...BASE,
    status: "warn",
    detail: failedDetail(base, result),
    severity: "low",
    suggestion:
      "Run license-checker --json --production in the project and correct the reported error.",
    didNotRun: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** One `[licenses.allow]` entry that has both a license and a reason. */
interface AllowRule {
  pattern: string;
  license: string;
}

interface Allowlist {
  rules: AllowRule[];
  /** Entries that miss a license or a reason. They are reported, never applied. */
  invalid: string[];
}

const NO_ALLOWLIST: Allowlist = { rules: [], invalid: [] };

async function loadAllowlist(root: string): Promise<Allowlist> {
  let allow: Record<string, { license?: string; reason?: string }> | undefined;
  try {
    const { loadConfig } = await import("./config.js");
    allow = (await loadConfig(resolve(root, ".kit.toml"))).licenses?.allow;
  } catch {
    return NO_ALLOWLIST; // no .kit.toml, or one that other checks already report
  }
  if (!allow) return NO_ALLOWLIST;
  const rules: AllowRule[] = [];
  const invalid: string[] = [];
  for (const [pattern, entry] of Object.entries(allow)) {
    const license = entry.license?.trim();
    if (license && entry.reason?.trim()) rules.push({ pattern, license });
    else invalid.push(pattern);
  }
  return { rules, invalid };
}

/** Package name from a license-checker key such as `@scope/name@1.2.3`. */
function packageName(key: string): string {
  const at = key.lastIndexOf("@");
  return at > 0 ? key.slice(0, at) : key;
}

function isAllowed(key: string, license: string, rules: AllowRule[]): boolean {
  const name = packageName(key);
  return rules.some(
    (rule) =>
      rule.license === license &&
      (rule.pattern.endsWith("*")
        ? name.startsWith(rule.pattern.slice(0, -1))
        : name === rule.pattern),
  );
}

function listed(items: string[]): string {
  const remainder = items.length > 3 ? ` +${items.length - 3} more` : "";
  return `${items.slice(0, 3).join(", ")}${remainder}`;
}

function scanVerdict(result: ExecResult, allowlist: Allowlist): SecurityCheckResult {
  try {
    const packages: unknown = JSON.parse(result.stdout);
    if (!isRecord(packages)) return failure(result, true);
    const violations: string[] = [];
    const accepted: string[] = [];
    for (const [pkg, info] of Object.entries(packages)) {
      if (!isRecord(info) || (info.licenses !== undefined && typeof info.licenses !== "string")) {
        throw new Error("invalid license entry");
      }
      const license = info.licenses ?? "";
      if (!PROBLEMATIC_LICENSES.some((name) => license.toUpperCase().includes(name))) continue;
      if (isAllowed(pkg, license, allowlist.rules)) accepted.push(pkg);
      else violations.push(`${pkg} (${license})`);
    }
    const notes: string[] = [];
    if (accepted.length) notes.push(`${accepted.length} accepted: ${listed(accepted)}`);
    if (allowlist.invalid.length) {
      notes.push(
        `ignored [licenses.allow] entries with no reason or license: ${listed(allowlist.invalid)}`,
      );
    }
    const suffix = notes.length ? ` (${notes.join("; ")})` : "";
    if (violations.length === 0 && allowlist.invalid.length === 0) {
      return { ...BASE, status: "pass", detail: `no problematic licenses found${suffix}` };
    }
    if (violations.length === 0) {
      return {
        ...BASE,
        status: "warn",
        detail: `no problematic licenses found${suffix}`,
        severity: "low",
        suggestion: "Give each [licenses.allow] entry in .kit.toml both a license and a reason.",
      };
    }
    return {
      ...BASE,
      status: "warn",
      detail: `${violations.length} copyleft license(s): ${listed(violations)}${suffix}`,
      severity: "medium",
      suggestion:
        'If the use is acceptable, add it under [licenses.allow] in .kit.toml: "<package or prefix*>" = { license = "<exact license>", reason = "<why>" }.',
    };
  } catch {
    return failure(result, true);
  }
}

/** Report license findings separately from a missing scanner or an incomplete scan. */
export async function checkLicenses(
  root: string,
  tools = { resolveToolBin, execFileNoThrow },
): Promise<SecurityCheckResult> {
  try {
    await access(resolve(root, "package.json"));
  } catch {
    return { ...BASE, status: "skip", detail: "no package.json found" };
  }
  const bin = await tools.resolveToolBin("license-checker");
  if (!bin) return unavailable();
  const result = await tools.execFileNoThrow(bin, ["--json", "--production"], {
    timeout: 120_000,
    cwd: root,
  });
  return result.ok ? scanVerdict(result, await loadAllowlist(root)) : failure(result);
}
