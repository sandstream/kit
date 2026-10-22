/**
 * Schema, validation and merging for the `kit upstream` release-source catalog. Pure functions:
 * no file access and no network. The built-in rows are in upstream-catalog-data.ts, and a project
 * adds or overrides rows with `[upstream.<id>]` in `.kit.toml`.
 */

export interface UpstreamEntry {
  id: string;
  label: string;
  /** npm package names that carry this service's releases. */
  npm: string[];
  /** GitHub repos, `owner/name`, whose releases carry its notes. */
  github: string[];
  /** `[services.<name>]` keys in `.kit.toml` that mean this service. */
  kitServices: string[];
}

export interface UpstreamOverride {
  id: string;
  label?: string;
  npm?: string[];
  github?: string[];
  kitServices?: string[];
  disabled?: boolean;
}

const ENTRY_KEYS = new Set(["id", "label", "npm", "github", "kitServices"]);
const OVERRIDE_KEYS = new Set(["label", "npm", "github", "kitServices", "disabled"]);
const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SERVICE_ID = /^[a-z0-9][a-z0-9_-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(where: string, row: Record<string, unknown>, known: Set<string>): void {
  for (const key of Object.keys(row)) {
    if (!known.has(key)) throw new Error(`${where}: unknown key "${key}"`);
  }
}

function stringList(where: string, key: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim() === "")) {
    throw new Error(`${where}: "${key}" must be a list of non-empty strings`);
  }
  return [...new Set((value as string[]).map((v) => v.trim()))];
}

function githubList(where: string, value: unknown): string[] {
  const repos = stringList(where, "github", value);
  for (const repo of repos) {
    if (!GITHUB_REPO.test(repo)) {
      throw new Error(`${where}: github repo "${repo}" must be owner/name`);
    }
  }
  return repos;
}

function requireSource(where: string, entry: UpstreamEntry): UpstreamEntry {
  if (entry.npm.length === 0 && entry.github.length === 0) {
    throw new Error(`${where}: needs at least one npm package or GitHub repo`);
  }
  return entry;
}

function checkId(where: string, id: unknown): string {
  if (typeof id !== "string" || !SERVICE_ID.test(id)) {
    throw new Error(`${where}: id must be lowercase letters, digits, "-" or "_"`);
  }
  return id;
}

export function validateUpstreamCatalog(data: unknown): UpstreamEntry[] {
  if (!Array.isArray(data)) throw new Error("upstream catalog must be an array");
  const seen = new Set<string>();
  return data.map((row, index) => {
    const where = `upstream catalog row ${index + 1}`;
    if (!isRecord(row)) throw new Error(`${where}: must be a table`);
    rejectUnknownKeys(where, row, ENTRY_KEYS);
    const id = checkId(where, row.id);
    if (seen.has(id)) throw new Error(`${where}: duplicate id "${id}"`);
    seen.add(id);
    if (typeof row.label !== "string" || row.label.trim() === "") {
      throw new Error(`${where}: label must be a non-empty string`);
    }
    return requireSource(where, {
      id,
      label: row.label,
      npm: stringList(where, "npm", row.npm),
      github: githubList(where, row.github),
      kitServices: stringList(where, "kitServices", row.kitServices),
    });
  });
}

/** Read the `[upstream]` table of `.kit.toml`; an absent table gives no rows. */
export function parseUpstreamTable(table: unknown): UpstreamOverride[] {
  if (table === undefined) return [];
  if (!isRecord(table)) throw new Error("[upstream] must be a table");
  return Object.entries(table).map(([id, row]) => {
    const where = `[upstream.${id}]`;
    checkId(where, id);
    if (!isRecord(row)) throw new Error(`${where} must be a table`);
    rejectUnknownKeys(where, row, OVERRIDE_KEYS);
    if (row.disabled !== undefined && typeof row.disabled !== "boolean") {
      throw new Error(`${where}: "disabled" must be true or false`);
    }
    if (row.label !== undefined && (typeof row.label !== "string" || row.label.trim() === "")) {
      throw new Error(`${where}: label must be a non-empty string`);
    }
    const out: UpstreamOverride = { id };
    if (row.label !== undefined) out.label = row.label as string;
    if (row.npm !== undefined) out.npm = stringList(where, "npm", row.npm);
    if (row.github !== undefined) out.github = githubList(where, row.github);
    if (row.kitServices !== undefined)
      out.kitServices = stringList(where, "kitServices", row.kitServices);
    if (row.disabled !== undefined) out.disabled = row.disabled;
    return out;
  });
}

const OVERRIDE_FIELDS = ["label", "npm", "github", "kitServices"] as const;

function applyOverride(current: UpstreamEntry | undefined, o: UpstreamOverride): UpstreamEntry {
  const merged: UpstreamEntry = current ?? {
    id: o.id,
    label: o.id,
    npm: [],
    github: [],
    kitServices: [],
  };
  for (const field of OVERRIDE_FIELDS) {
    const value = o[field];
    if (value !== undefined) Object.assign(merged, { [field]: value });
  }
  return requireSource(`[upstream.${o.id}]`, merged);
}

/**
 * Apply project overrides to the built-in catalog. A listed field replaces the built-in one, a
 * `disabled` row removes the service, and an unknown id adds a service. The input is not changed.
 */
export function mergeUpstreamCatalog(
  base: readonly UpstreamEntry[],
  overrides: readonly UpstreamOverride[],
): UpstreamEntry[] {
  const byId = new Map<string, UpstreamEntry>(
    base.map((e) => [
      e.id,
      { ...e, npm: [...e.npm], github: [...e.github], kitServices: [...e.kitServices] },
    ]),
  );
  for (const o of overrides) {
    if (o.disabled) byId.delete(o.id);
    else byId.set(o.id, applyOverride(byId.get(o.id), o));
  }
  return [...byId.values()];
}
