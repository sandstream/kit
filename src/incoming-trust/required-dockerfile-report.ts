import { dockerfileVerdict, isInspectedDockerfile } from "../check-code-guardrails.js";
import type { SecurityCheckResult } from "../check-security.js";
import { parseJsonObject } from "../utils/json-object.js";
import type { IncomingRun } from "./launch-node-macos.js";
import { relativePath } from "./npm-lock-workspaces.js";
import type { IncomingSnapshotEntry } from "./snapshot-format.js";

interface ReportedHit {
  file: string;
  line: number;
  indicator: string;
}

export function requiredDockerfilePaths(
  entries: readonly IncomingSnapshotEntry[],
  inspector: string,
): ReadonlySet<string> | undefined {
  if (!entries.some(({ kind, path }) => kind === "file" && path === inspector)) return undefined;
  const paths = new Set<string>();
  for (const { kind, path } of entries) {
    if (!isInspectedDockerfile(path)) continue;
    if (kind === "symlink" || !relativePath(path)) return undefined;
    if (kind === "file") paths.add(path);
  }
  return paths;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validHit(value: unknown, expected: ReadonlySet<string>): value is ReportedHit {
  return (
    record(value) &&
    typeof value.file === "string" &&
    expected.has(value.file) &&
    typeof value.line === "number" &&
    Number.isSafeInteger(value.line) &&
    value.line > 0 &&
    typeof value.indicator === "string" &&
    /^[A-Z_][A-Z0-9_]{0,127}_(?:PASSWORD|SECRET|TOKEN)$/i.test(value.indicator)
  );
}

function parseReport(stdout: string, files: ReadonlySet<string>): ReportedHit[] | undefined {
  const parsed = parseJsonObject(Buffer.from(stdout), 1024 * 1024);
  if (!("value" in parsed)) return undefined;
  const report = parsed.value;
  if (
    report.schema !== "kit.dockerfile-inspection/v1" ||
    Object.keys(report).sort().join(",") !== "hits,scanned,schema"
  )
    return undefined;
  const { scanned, hits } = report;
  if (!Array.isArray(scanned) || !Array.isArray(hits) || scanned.length !== files.size)
    return undefined;
  const covered = new Set(scanned);
  if (covered.size !== files.size || [...files].some((file) => !covered.has(file)))
    return undefined;
  return hits.every((hit) => validHit(hit, files)) ? hits : undefined;
}

/** Only a clean run with complete coverage can supply evidence to the required check. */
export function finishRequiredDockerfileInspection(
  run: IncomingRun,
  files: ReadonlySet<string> | undefined,
): IncomingRun {
  if (run.ran !== true) return run;
  const examined =
    run.outcome === "exited" &&
    run.code === 0 &&
    !run.cleanupStep &&
    files &&
    parseReport(run.stdout, files);
  const check: SecurityCheckResult | null = examined
    ? dockerfileVerdict({ hits: examined, errors: [] })
    : null;
  return {
    ...run,
    outcome:
      run.outcome === "exited" && run.code === 0 && check?.status !== "pass"
        ? "check-failed"
        : run.outcome,
    stdout: "",
    stderr: "",
    requiredCheck: check ?? {
      category: "secrets",
      name: "literal Dockerfile secret",
      status: "fail",
      detail: "Required Dockerfile inspection did not provide complete evidence",
      didNotRun: true,
    },
  };
}
