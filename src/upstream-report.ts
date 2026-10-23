/**
 * The `kit upstream check` report: detect the services of a project, look up their latest versions
 * and release notes, and decide a verdict per service and package. The lookup is injectable so
 * tests never open a socket. Nothing here prints; `commands/upstream.ts` renders the report.
 */
import { classifyBump, decideVerdict, extractNoteHits } from "./upstream-compare.js";
import type { Bump, NoteHit, Verdict } from "./upstream-compare.js";
import {
  mergeUpstreamCatalog,
  parseUpstreamTable,
  validateUpstreamCatalog,
} from "./upstream-catalog.js";
import { UPSTREAM_CATALOG_DATA } from "./upstream-catalog-data.js";
import { detectUpstreamServices, loadUpstreamInputs } from "./upstream-detect.js";
import type { SkippedInput } from "./upstream-detect.js";
import { resolveInstalledVersion } from "./upstream-installed.js";
import type { InstalledSource } from "./upstream-installed.js";
import { buildRuntimeRows } from "./upstream-runtime-report.js";
import type { RuntimeDeps, RuntimeRow } from "./upstream-runtime-report.js";
import { lookupUpstream, stripControl } from "./upstream-sources.js";
import type { ReleaseInfo, UpstreamLookup, UpstreamService } from "./upstream-sources.js";

export interface UpstreamRow {
  id: string;
  label: string;
  package: string | null;
  manifest: string | null;
  installed: string | null;
  installedSource: InstalledSource | null;
  range: string | null;
  latest: string | null;
  bump: Bump;
  verdict: Verdict;
  notes: NoteHit[];
  /** False when no GitHub release of the service could be read, so the notes check had nothing to scan. */
  notesAvailable: boolean;
  detail?: string;
}

export interface UpstreamReport {
  status: "ok" | "skipped";
  reason?: string;
  rows: UpstreamRow[];
  /** The Node, PHP and Python interpreters the project uses, against their latest patch. */
  runtimes: RuntimeRow[];
  skippedInputs: SkippedInput[];
}

export interface ReportDeps {
  lookup?: (service: UpstreamService) => Promise<UpstreamLookup>;
  /** Reads the installed interpreter version; tests inject it so no binary runs. */
  readInstalled?: RuntimeDeps["readInstalled"];
  /** False leaves the runtime check out. Default true. */
  runtimes?: boolean;
}

type Detected = ReturnType<typeof detectUpstreamServices>[number];

function releasesOf(lookup: UpstreamLookup): ReleaseInfo[] {
  return lookup.github.flatMap((g) => (g.ok ? g.releases : []));
}

function joinDetail(parts: (string | undefined)[]): string | undefined {
  const text = stripControl(parts.filter(Boolean).join("; "));
  return text === "" ? undefined : text;
}

function packageRow(
  root: string,
  service: Detected,
  lookup: UpstreamLookup,
  evidence: Detected["evidence"][number],
): UpstreamRow {
  const installed = resolveInstalledVersion(
    root,
    evidence.source,
    evidence.name,
    evidence.declared ?? "",
  );
  const npm = lookup.npm.find((n) => n.name === evidence.name);
  const latest = npm?.ok ? npm.latest : null;
  const releases = releasesOf(lookup);
  const notes = extractNoteHits(releases, installed.version);
  const bump = classifyBump(installed.version, latest);
  const lookupState = lookup.status === "skipped" ? "skipped" : latest ? "ok" : "unknown";
  return {
    id: service.id,
    label: service.label,
    package: evidence.name,
    manifest: evidence.source,
    installed: installed.version,
    installedSource: installed.source,
    range: installed.range,
    latest,
    bump,
    verdict: decideVerdict({ lookup: lookupState, bump, hits: notes }),
    notes,
    notesAvailable: releases.length > 0,
    detail: joinDetail([
      npm && !npm.ok ? npm.error : undefined,
      installed.source === "declared-range"
        ? "installed version estimated from the declared range"
        : undefined,
      installed.note,
    ]),
  };
}

function noPackageRow(service: Detected, lookup: UpstreamLookup): UpstreamRow {
  return {
    id: service.id,
    label: service.label,
    package: null,
    manifest: null,
    installed: null,
    installedSource: null,
    range: null,
    latest: null,
    bump: "unknown",
    verdict: lookup.status === "skipped" ? "skipped" : "unknown",
    notes: [],
    notesAvailable: releasesOf(lookup).length > 0,
    detail: "declared in .kit.toml, no package found to compare",
  };
}

export async function buildUpstreamReport(
  root: string,
  deps: ReportDeps = {},
): Promise<UpstreamReport> {
  const inputs = loadUpstreamInputs(root);
  const catalog = mergeUpstreamCatalog(
    validateUpstreamCatalog(UPSTREAM_CATALOG_DATA),
    parseUpstreamTable(inputs.upstream),
  );
  const services = detectUpstreamServices({
    catalog,
    kitServices: inputs.kitServices,
    manifests: inputs.manifests,
  });
  const base = deps.lookup ?? ((svc) => lookupUpstream(svc));
  const seen: UpstreamLookup[] = [];
  const lookup = async (svc: UpstreamService): Promise<UpstreamLookup> => {
    const result = await base(svc);
    seen.push(result);
    return result;
  };
  const rows: UpstreamRow[] = [];
  for (const service of services) {
    const result = await lookup({ npm: service.npm, github: service.github });
    const packages = service.evidence.filter((e) => e.kind === "package-json");
    if (packages.length === 0) rows.push(noPackageRow(service, result));
    for (const evidence of packages) rows.push(packageRow(root, service, result, evidence));
  }
  const runtimes =
    deps.runtimes === false
      ? []
      : await buildRuntimeRows(root, { lookup, readInstalled: deps.readInstalled });
  const allSkipped = seen.length > 0 && seen.every((r) => r.status === "skipped");
  return {
    status: allSkipped ? "skipped" : "ok",
    ...(allSkipped && seen[0].reason ? { reason: seen[0].reason } : {}),
    rows,
    runtimes,
    skippedInputs: inputs.skipped,
  };
}

/** `--enforce` fails on a major, a deprecation hit, a runtime security release or an end-of-life runtime, and on nothing else. */
export function enforceFails(
  report: Pick<UpstreamReport, "rows"> & { runtimes?: RuntimeRow[] },
): boolean {
  return (
    report.rows.some(
      (r) => r.verdict === "major, read notes" || r.verdict === "upgrade recommended (deprecation)",
    ) ||
    (report.runtimes ?? []).some(
      (r) => r.verdict === "security release available" || r.verdict === "end of life",
    )
  );
}
