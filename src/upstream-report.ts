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
import { lookupUpstream } from "./upstream-sources.js";
import type { ReleaseInfo, UpstreamLookup } from "./upstream-sources.js";

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
  skippedInputs: SkippedInput[];
}

export interface ReportDeps {
  lookup?: (service: { npm: string[]; github: string[] }) => Promise<UpstreamLookup>;
}

type Detected = ReturnType<typeof detectUpstreamServices>[number];

function releasesOf(lookup: UpstreamLookup): ReleaseInfo[] {
  return lookup.github.flatMap((g) => (g.ok ? g.releases : []));
}

function joinDetail(parts: (string | undefined)[]): string | undefined {
  const text = parts.filter(Boolean).join("; ");
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
  const lookup = deps.lookup ?? ((svc) => lookupUpstream(svc));
  const rows: UpstreamRow[] = [];
  let skipReason: string | undefined;
  let skippedCount = 0;
  for (const service of services) {
    const result = await lookup({ npm: service.npm, github: service.github });
    if (result.status === "skipped") {
      skippedCount++;
      skipReason = result.reason;
    }
    const packages = service.evidence.filter((e) => e.kind === "package-json");
    if (packages.length === 0) rows.push(noPackageRow(service, result));
    for (const evidence of packages) rows.push(packageRow(root, service, result, evidence));
  }
  const allSkipped = services.length > 0 && skippedCount === services.length;
  return {
    status: allSkipped ? "skipped" : "ok",
    ...(allSkipped && skipReason ? { reason: skipReason } : {}),
    rows,
    skippedInputs: inputs.skipped,
  };
}

/** `--enforce` fails on a major or a deprecation hit and on nothing else. */
export function enforceFails(report: Pick<UpstreamReport, "rows">): boolean {
  return report.rows.some(
    (r) => r.verdict === "major, read notes" || r.verdict === "upgrade recommended (deprecation)",
  );
}
