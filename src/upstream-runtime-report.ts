/**
 * The runtime half of the `kit upstream` report: one row per Node, PHP or Python interpreter the
 * project uses. The lookup and the installed-version reader are injectable, so tests open no socket
 * and run no binary. Air gap and read-only mode skip the lookup and the row says so.
 */
import {
  decideRuntime,
  detectRuntimes,
  projectPinsApplied,
  readInstalledVersion,
  RUNTIME_SPECS,
} from "./upstream-runtimes.js";
import type {
  DetectedRuntime,
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

function serviceFor(spec: RuntimeSpec): UpstreamService {
  return spec.source === "releases"
    ? { npm: [], github: [spec.github], releaseWindow: spec.window }
    : { npm: [], github: [], githubTags: [spec.github] };
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
  const error = sourceError(lookup);
  if (lookup.status === "unknown" || (error !== undefined && installed !== null)) {
    return {
      ...base,
      latest: null,
      verdict: "unknown",
      evidence: [],
      detail: error ?? "release data could not be read",
    };
  }
  const releases = lookup.github.flatMap((g) => (g.ok ? g.releases : []));
  const tags = lookup.tags.flatMap((t) => (t.ok ? t.tags : []));
  const verdict = decideRuntime(spec, installed, releases, tags);
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
