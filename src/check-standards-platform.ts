/**
 * kit standards — P4 platform gate: the deploy surface, not a language.
 *
 * P4 ships the CONTAINER gate: if the repo has a Dockerfile, lint it with hadolint
 * (Dockerfile best-practice + embedded-shell checks). Same contract as every other
 * standards dimension — deterministic, net-new-gated against the baseline, warn by
 * default / `--enforce` fail-closed, and an honest setup gap when hadolint is absent.
 *
 * Pure parser (parseHadolintJson) is unit-tested against fixture output.
 */
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { resolveToolBin } from "./utils/resolveTool.js";
import { execFileNoThrow, type ExecResult } from "./utils/execFileNoThrow.js";
import type { StandardsCheckResult } from "./check-standards.js";

export interface PlatformFinding {
  file: string;
  line?: number;
  rule?: string;
  message?: string;
}

/** Stable baseline key for a platform finding. */
export const platformKey = (tool: string, f: PlatformFinding): string =>
  `platform/${tool}:${f.file}${f.rule ? `#${f.rule}` : f.line ? `:${f.line}` : ""}`;

/** hadolint `--format json`: `[{ file, line, column, level, code, message }]`. */
export function parseHadolintJson(res: ExecResult): PlatformFinding[] {
  let data: unknown;
  try {
    data = JSON.parse(res.stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: PlatformFinding[] = [];
  for (const d of data) {
    const item = (d ?? {}) as Record<string, unknown>;
    const file = typeof item.file === "string" ? item.file : undefined;
    if (!file) continue;
    out.push({
      file,
      line: typeof item.line === "number" ? item.line : undefined,
      rule: typeof item.code === "string" ? item.code : undefined,
      message: typeof item.message === "string" ? item.message : undefined,
    });
  }
  return out;
}

const DOCKERFILE_RE = /^Dockerfile(\..+)?$|\.Dockerfile$/i;
const DOCKER_SKIP = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".git",
  "vendor",
  "target",
]);

/** Locate Dockerfiles in the repo (bounded depth ≤4), vendor-excluded. */
export function findDockerfiles(cwd: string, maxDepth = 4): string[] {
  const found: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!DOCKER_SKIP.has(e.name)) visit(join(dir, e.name), depth + 1);
      } else if (DOCKERFILE_RE.test(e.name)) {
        found.push(join(dir, e.name));
      }
    }
  };
  visit(cwd, 0);
  return found;
}

export interface PlatformScan {
  dockerfiles: string[];
  findings: PlatformFinding[];
  didNotRun: boolean;
}

/** Run hadolint over the repo's Dockerfiles. */
export async function scanContainer(cwd: string): Promise<PlatformScan> {
  const dockerfiles = findDockerfiles(cwd);
  if (dockerfiles.length === 0) {
    return { dockerfiles: [], findings: [], didNotRun: false }; // nothing to lint ⇒ clean skip, not a gap
  }
  const bin = await resolveToolBin("hadolint");
  if (!bin) return { dockerfiles, findings: [], didNotRun: true };
  const res = await execFileNoThrow(bin, ["--format", "json", ...dockerfiles], {
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
    cwd,
  });
  // hadolint exits non-zero when it finds issues; only a run with no parseable JSON is a real failure.
  const findings = parseHadolintJson(res);
  if (!res.ok && findings.length === 0 && !res.stdout.trim()) {
    return { dockerfiles, findings: [], didNotRun: true };
  }
  return { dockerfiles, findings, didNotRun: false };
}

export interface CheckPlatformOptions {
  cwd?: string;
  enforce?: boolean;
  baseline?: string[];
  scan?: PlatformScan;
}

/** Build the StandardsCheckResult[] for the platform (container) gate. */
export async function checkStandardsPlatform(
  opts: CheckPlatformOptions = {},
): Promise<StandardsCheckResult[]> {
  const cwd = opts.cwd ?? process.cwd();
  const enforce = opts.enforce ?? false;
  const scan = opts.scan ?? (await scanContainer(cwd));

  // No Dockerfile at all → the container gate simply doesn't apply (no output).
  if (scan.dockerfiles.length === 0) return [];

  const name = "container: hadolint";
  if (scan.didNotRun) {
    return [
      {
        category: "standards",
        dimension: "platform",
        name,
        status: enforce ? "fail" : "warn",
        severity: enforce ? "high" : "low",
        didNotRun: true,
        detail: `${scan.dockerfiles.length} Dockerfile(s) found but hadolint is not installed — container gate did not run (setup gap); --enforce fails CI on setup gaps`,
      },
    ];
  }
  const rel = scan.findings.map((f) => ({ ...f, file: relPath(cwd, f.file) }));
  const seen = new Set(opts.baseline ?? []);
  const fresh = rel.filter((f) => !seen.has(platformKey("hadolint", f)));
  if (rel.length === 0) {
    return [
      {
        category: "standards",
        dimension: "platform",
        name,
        status: "pass",
        detail: `${scan.dockerfiles.length} Dockerfile(s) — no hadolint findings`,
      },
    ];
  }
  if (fresh.length === 0) {
    return [
      {
        category: "standards",
        dimension: "platform",
        name,
        status: "warn",
        severity: "low",
        detail: `${rel.length} pre-existing Dockerfile finding(s) (baseline-frozen)`,
      },
    ];
  }
  return [
    {
      category: "standards",
      dimension: "platform",
      name,
      status: enforce ? "fail" : "warn",
      severity: enforce ? "high" : "medium",
      detail: `${fresh.length} new Dockerfile finding(s) (${rel.length} total)`,
      files: fresh
        .slice(0, 10)
        .map(
          (f) =>
            `${f.file}${f.line ? `:${f.line}` : ""}${f.rule ? ` [${f.rule}]` : ""}${
              f.message ? ` ${f.message}` : ""
            }`,
        ),
    },
  ];
}

function relPath(cwd: string, p: string): string {
  return relative(cwd, p) || p;
}

/** Snapshot current container findings for `kit baseline freeze`. */
export async function collectPlatformKeys(cwd: string): Promise<string[]> {
  const scan = await scanContainer(cwd);
  if (scan.didNotRun) return [];
  return scan.findings.map((f) => platformKey("hadolint", { ...f, file: relPath(cwd, f.file) }));
}
