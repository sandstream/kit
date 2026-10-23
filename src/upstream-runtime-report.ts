/**
 * The runtime half of the `kit upstream` report: one row per Node, PHP or Python interpreter the
 * project uses. The lookup and the installed-version reader are injectable, so tests open no socket
 * and run no binary. Air gap and read-only mode skip the lookup and the row says so.
 */
import {
  decideRuntime,
  detectRuntimes,
  lineEndOfLife,
  projectPinsApplied,
  readInstalledVersion,
  RUNTIME_SPECS,
} from "./upstream-runtimes.js";
import type {
  DetectedRuntime,
  RuntimeAssessment,
  RuntimeId,
  RuntimeSpec,
  RuntimeVerdict,
} from "./upstream-runtimes.js";
import { lookupUpstream } from "./upstream-sources.js";
import type { UpstreamLookup, UpstreamService } from "./upstream-sources.js";

export interface RuntimeRow {
  id: RuntimeId;
  label: string;
  installed: string | null;
  declared: string | null;
  declaredFrom: string | null;
  latest: string | null;
  verdict: RuntimeVerdict;
  evidence: string[];
  detail?: string;
}

export interface RuntimeDeps {
  lookup?: (service: UpstreamService) => Promise<UpstreamLookup>;
  readInstalled?: ((spec: RuntimeSpec, cwd: string) => Promise<string | null>) | undefined;
}

/** The sources one runtime needs: its releases or tags, and its end-of-life schedule when one is hosted. */
export function serviceFor(spec: RuntimeSpec): UpstreamService {
  const base: UpstreamService =
    spec.source === "releases"
      ? { npm: [], github: [spec.github], releaseWindow: spec.window }
      : { npm: [], github: [], githubTags: [spec.github] };
  return spec.schedule ? { ...base, githubFiles: [spec.schedule] } : base;
}

/**
 * One verdict from what a lookup returned. An end-of-life line is decided from the schedule alone, so
 * it is reported even when the release data is missing. Anything that cannot be read is `unknown`,
 * and a source that answered nothing never reads as current.
 */
export function assessFromLookup(
  spec: RuntimeSpec,
  installed: string | null,
  lookup: UpstreamLookup,
  nowMs: number,
): RuntimeAssessment {
  if (installed === null) return decideRuntime(spec, null, [], []);
  const file = lookup.files[0];
  const lineEnd = file?.ok ? lineEndOfLife(spec, installed, file.text, nowMs) : null;
  if (lineEnd?.ended) return decideRuntime(spec, installed, [], [], lineEnd);
  const error = sourceError(lookup);
  if (lookup.status === "unknown" || error !== undefined) {
    return {
      verdict: "unknown",
      latest: null,
      evidence: [],
      detail: error ?? "release data could not be read",
    };
  }
  const releases = lookup.github.flatMap((g) => (g.ok ? g.releases : []));
  const tags = lookup.tags.flatMap((t) => (t.ok ? t.tags : []));
  const out = decideRuntime(spec, installed, releases, tags, lineEnd);
  const scheduleNote = !spec.schedule
    ? undefined
    : !file?.ok
      ? "end-of-life data not available"
      : lineEnd === null
        ? "the release schedule does not date this line"
        : undefined;
  const detail = [out.detail, scheduleNote].filter(Boolean).join("; ");
  return {
    ...out,
    ...(detail ? { detail } : {}),
    ...(lineEnd && !lineEnd.ended ? { supportedUntil: lineEnd.end } : {}),
  };
}

function declaredNote(declared: string | null, installed: string | null): string | undefined {
  const wanted = /^\D*(\d+)/.exec(declared ?? "")?.[1];
  const have = installed?.split(".")[0];
  if (!wanted || !have || wanted === have) return undefined;
  const hint = projectPinsApplied()
    ? ""
    : " (the machine default; project pins are not applied, see KIT_UPSTREAM_PROJECT_PINS)";
  return `declared ${declared}, installed ${installed}${hint}`;
}

function sourceError(lookup: UpstreamLookup): string | undefined {
  const failed = [...lookup.github, ...lookup.tags].find((s) => !s.ok);
  return failed && !failed.ok ? failed.error : undefined;
}

async function rowFor(
  detected: DetectedRuntime,
  root: string,
  deps: Required<RuntimeDeps>,
): Promise<RuntimeRow> {
  const spec = RUNTIME_SPECS.find((s) => s.id === detected.id) as RuntimeSpec;
  const installed = await deps.readInstalled(spec, root);
  const lookup = await deps.lookup(serviceFor(spec));
  const base = {
    id: spec.id,
    label: spec.label,
    installed,
    declared: detected.declared,
    declaredFrom: detected.declaredFrom,
  };
  if (lookup.status === "skipped") {
    return {
      ...base,
      latest: null,
      verdict: "skipped",
      evidence: [],
      detail: declaredNote(detected.declared, installed),
    };
  }
  const verdict = assessFromLookup(spec, installed, lookup, Date.now());
  const note = declaredNote(detected.declared, installed);
  const detail = [verdict.detail, note].filter(Boolean).join("; ");
  return {
    ...base,
    latest: verdict.latest,
    verdict: verdict.verdict,
    evidence: verdict.evidence,
    ...(detail ? { detail } : {}),
  };
}

export async function buildRuntimeRows(
  root: string,
  deps: RuntimeDeps = {},
): Promise<RuntimeRow[]> {
  const full: Required<RuntimeDeps> = {
    lookup: deps.lookup ?? ((service) => lookupUpstream(service)),
    readInstalled: deps.readInstalled ?? readInstalledVersion,
  };
  const rows: RuntimeRow[] = [];
  for (const detected of detectRuntimes(root)) rows.push(await rowFor(detected, root, full));
  return rows;
}
