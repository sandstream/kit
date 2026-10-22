/**
 * Service detection for `kit upstream`. `detectUpstreamServices` is a pure function over three
 * inputs: `[services.*]` keys from `.kit.toml`, dependencies of every package.json found, and the
 * catalog (already merged with the project's `[upstream]` table). `loadUpstreamInputs` reads those
 * inputs from disk. Neither opens a network connection.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { UpstreamEntry } from "./upstream-catalog.js";

export interface ManifestDeps {
  /** Path relative to the project root, with `/` separators. */
  path: string;
  dependencies: Record<string, string>;
}

export interface SkippedInput {
  path: string;
  reason: string;
}

export interface UpstreamInputs {
  kitServices: string[];
  /** The raw `[upstream]` table, for `parseUpstreamTable`. */
  upstream: Record<string, unknown> | undefined;
  manifests: ManifestDeps[];
  /** Files that exist but could not be read. Reported, never treated as empty. */
  skipped: SkippedInput[];
}

export interface ServiceEvidence {
  kind: "kit-toml" | "package-json";
  source: string;
  name: string;
  /** The version range the manifest declares. Absent for `.kit.toml`. */
  declared?: string;
}

export interface DetectedUpstreamService {
  id: string;
  label: string;
  npm: string[];
  github: string[];
  evidence: ServiceEvidence[];
}

export interface DetectInput {
  catalog: readonly UpstreamEntry[];
  kitServices: readonly string[];
  manifests: readonly ManifestDeps[];
}

export function detectUpstreamServices(input: DetectInput): DetectedUpstreamService[] {
  const found: DetectedUpstreamService[] = [];
  for (const entry of input.catalog) {
    const evidence: ServiceEvidence[] = [];
    const serviceKeys = new Set([entry.id, ...entry.kitServices]);
    for (const key of input.kitServices) {
      if (serviceKeys.has(key)) evidence.push({ kind: "kit-toml", source: ".kit.toml", name: key });
    }
    for (const manifest of input.manifests) {
      for (const name of entry.npm) {
        const declared = manifest.dependencies[name];
        if (declared !== undefined) {
          evidence.push({ kind: "package-json", source: manifest.path, name, declared });
        }
      }
    }
    if (evidence.length === 0) continue;
    found.push({
      id: entry.id,
      label: entry.label,
      npm: [...entry.npm],
      github: [...entry.github],
      evidence,
    });
  }
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

const SKIPPED_DIRS = new Set(["node_modules", "dist", "build", "vendor", "target", "coverage"]);
const MAX_DEPTH = 3;
const MAX_ENTRIES = 5000;
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

function findPackageJsonPaths(root: string): string[] {
  const found: string[] = [];
  let seen = 0;
  const walk = (rel: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++seen > MAX_ENTRIES) return;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isFile() && entry.name === "package.json") found.push(childRel);
      else if (
        entry.isDirectory() &&
        depth < MAX_DEPTH &&
        !entry.name.startsWith(".") &&
        !SKIPPED_DIRS.has(entry.name)
      ) {
        walk(childRel, depth + 1);
      }
    }
  };
  walk("", 0);
  return found.sort();
}

function readManifest(root: string, rel: string): ManifestDeps {
  const parsed: unknown = JSON.parse(readFileSync(join(root, rel), "utf-8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("not a JSON object");
  }
  const dependencies: Record<string, string> = {};
  for (const field of DEP_FIELDS) {
    const block = (parsed as Record<string, unknown>)[field];
    if (typeof block !== "object" || block === null) continue;
    for (const [name, range] of Object.entries(block)) {
      if (typeof range === "string" && !(name in dependencies)) dependencies[name] = range;
    }
  }
  return { path: rel, dependencies };
}

function readKitToml(
  root: string,
): Pick<UpstreamInputs, "kitServices" | "upstream"> & { skipped?: SkippedInput } {
  let text: string;
  try {
    text = readFileSync(join(root, ".kit.toml"), "utf-8");
  } catch {
    return { kitServices: [], upstream: undefined };
  }
  try {
    const raw = parseToml(text) as Record<string, unknown>;
    const services = raw.services;
    const upstream = raw.upstream;
    return {
      kitServices:
        typeof services === "object" && services !== null ? Object.keys(services).sort() : [],
      upstream:
        typeof upstream === "object" && upstream !== null
          ? (upstream as Record<string, unknown>)
          : undefined,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message.split("\n")[0] : "unreadable";
    return { kitServices: [], upstream: undefined, skipped: { path: ".kit.toml", reason } };
  }
}

export function loadUpstreamInputs(root: string): UpstreamInputs {
  const skipped: SkippedInput[] = [];
  const manifests: ManifestDeps[] = [];
  for (const rel of findPackageJsonPaths(root)) {
    try {
      manifests.push(readManifest(root, rel));
    } catch (err) {
      skipped.push({ path: rel, reason: err instanceof Error ? err.message : "unreadable" });
    }
  }
  const { skipped: tomlSkipped, ...toml } = readKitToml(root);
  if (tomlSkipped) skipped.push(tomlSkipped);
  return { ...toml, manifests, skipped };
}
