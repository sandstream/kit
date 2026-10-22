/**
 * The opt-in `upstream` dimension of `kit check`. It is informational: a package that is behind is a
 * warning, a source that could not be read is a did-not-run warning, and nothing here fails the
 * verdict. It runs only when selected with `--category upstream`, so an ordinary `kit check` stays
 * offline and stable.
 */
import { c } from "./utils/colors.js";
import type { UpstreamReport, UpstreamRow } from "./upstream-report.js";

export interface UpstreamCheckRow {
  name: string;
  status: "pass" | "warn";
  detail: string;
  didNotRun?: true;
}

function describe(row: UpstreamRow): string {
  const versions =
    row.installed || row.latest
      ? `${row.installed ?? "?"} -> ${row.latest ?? "?"}${row.bump !== "unknown" && row.bump !== "none" ? ` (${row.bump})` : ""}, `
      : "";
  return `${versions}${row.verdict}`;
}

export function upstreamRowsFromReport(report: UpstreamReport): UpstreamCheckRow[] {
  const rows: UpstreamCheckRow[] = report.rows.map((row) => {
    const didNotRun = row.verdict === "unknown" || row.verdict === "skipped";
    return {
      name: `${row.label}: ${row.package ?? "no package"}`,
      status: row.verdict === "current" ? "pass" : "warn",
      detail:
        report.status === "skipped" ? `skipped (${report.reason ?? "no network"})` : describe(row),
      ...(didNotRun ? { didNotRun: true as const } : {}),
    };
  });
  for (const skipped of report.skippedInputs) {
    rows.push({
      name: "upstream input",
      status: "warn",
      detail: `${skipped.path} ${skipped.reason}`,
      didNotRun: true,
    });
  }
  if (report.rows.length === 0 && report.skippedInputs.length === 0) {
    rows.push({ name: "upstream", status: "pass", detail: "no cataloged service found" });
  }
  return rows;
}

/** The rows `kit check --json` emits for this dimension. */
export function upstreamToJsonChecks(rows: readonly UpstreamCheckRow[]): {
  name: string;
  status: "pass" | "warn";
  detail: string;
  category: string;
  didNotRun?: true;
}[] {
  return rows.map((u) => ({
    name: u.name,
    status: u.status,
    detail: u.detail,
    category: "upstream",
    ...(u.didNotRun ? { didNotRun: true as const } : {}),
  }));
}

export async function checkUpstream(cwd: string): Promise<UpstreamCheckRow[]> {
  const { buildUpstreamReport } = await import("./upstream-report.js");
  const { stripControl } = await import("./upstream-sources.js");
  try {
    return upstreamRowsFromReport(await buildUpstreamReport(cwd));
  } catch (err) {
    // A bad [upstream] table is the operator's to fix; it must not crash the whole gate.
    const reason = stripControl(err instanceof Error ? err.message : "could not run");
    return [{ name: "upstream", status: "warn", detail: reason, didNotRun: true }];
  }
}

/** The text section `kit check --category upstream` prints. Prints nothing when the dimension did not run. */
export function printUpstreamTable(rows: readonly UpstreamCheckRow[]): void {
  if (rows.length === 0) return;
  console.log(`${c.cyan}Upstream versions${c.reset}`);
  for (const row of rows) {
    const icon = row.status === "pass" ? `${c.green}✓${c.reset}` : `${c.yellow}!${c.reset}`;
    console.log(`  ${icon} ${row.name}  ${c.dim}${row.detail}${c.reset}`);
  }
}
