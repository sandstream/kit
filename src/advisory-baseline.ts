/**
 * Fail on NEW dependency debt, not on the debt you already have.
 *
 * A repo with 30 known advisories cannot adopt a gate that fails on all 30 — it gets disabled the
 * same afternoon. What it can adopt is a gate that freezes today's debt in a file and fails the
 * moment something NEW appears. The design that makes this work, rather than rot:
 *
 *   - **The repo's own package manager does the auditing.** npm, pnpm, yarn or bun, whichever the
 *     lockfile says. No new tool to install, and no cloud service that gets handed the manifest.
 *   - **The known list is data, not code** (`.kit/advisories.json`), so a dependency bump produces a
 *     small readable diff instead of a code change.
 *   - **The file may only shrink.** An entry that no longer applies is an ERROR, not a shrug:
 *     without that rule the list silently accumulates dead ids, and a gate whose baseline nobody
 *     prunes stops meaning anything. Fixing a vulnerability and pruning the line belong in the same
 *     commit.
 *   - **Remaining debt is summarised per severity** on every run, so the size is visible without
 *     opening the file.
 *
 * The parser is deliberately shape-tolerant. npm, pnpm, yarn-berry and bun each report audits in a
 * different JSON shape, and all four bury the same three facts — a GHSA id, a package name, a
 * severity — at different depths. Walking the tree for those three is more durable than four
 * bespoke parsers, and when the walk finds nothing in a non-zero exit the check says it could not
 * run rather than reporting a clean audit.
 */

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export const ADVISORY_BASELINE_FILE = ".kit/advisories.json";

export type Severity = "critical" | "high" | "moderate" | "low" | "info";

const SEVERITY_ORDER: Severity[] = ["critical", "high", "moderate", "low", "info"];

export interface Advisory {
  /** GHSA identifier — the one id every ecosystem agrees on. */
  id: string;
  package: string;
  severity: Severity;
  title: string;
}

export interface Baseline {
  advisories: Record<string, Omit<Advisory, "id">>;
}

export interface AuditRunner {
  manager: string;
  command: string[];
}

/** Which package manager's audit to run, decided by the lockfile that is actually committed. */
export async function detectAuditRunner(root: string): Promise<AuditRunner | null> {
  const has = async (file: string): Promise<boolean> => {
    try {
      await access(join(root, file));
      return true;
    } catch {
      return false;
    }
  };
  if (await has("bun.lockb")) return { manager: "bun", command: ["bun", "audit", "--json"] };
  if (await has("bun.lock")) return { manager: "bun", command: ["bun", "audit", "--json"] };
  if (await has("pnpm-lock.yaml")) return { manager: "pnpm", command: ["pnpm", "audit", "--json"] };
  if (await has("yarn.lock"))
    return { manager: "yarn", command: ["yarn", "npm", "audit", "--json", "--all"] };
  if (await has("package-lock.json"))
    return { manager: "npm", command: ["npm", "audit", "--json"] };
  return null;
}

function normaliseSeverity(value: unknown): Severity | null {
  const s = String(value ?? "").toLowerCase();
  if (s === "medium") return "moderate";
  return (SEVERITY_ORDER as string[]).includes(s) ? (s as Severity) : null;
}

/**
 * Keys that are structure, not package names.
 *
 * bun reports `{"@babel/core": [ …advisories… ]}` — the package name is the OBJECT KEY and appears
 * in no field, so the walk has to read keys. npm reports `{"vulnerabilities": {"pkg": {…}}}`, where
 * reading keys blindly would invent a package called "vulnerabilities". Measured against both.
 */
const STRUCTURAL_KEYS = new Set([
  "vulnerabilities",
  "advisories",
  "metadata",
  "data",
  "actions",
  "muted",
  "findings",
  "via",
  "effects",
  "results",
  "dependencies",
  "devDependencies",
  "ignored",
  "children",
  "value",
  "objects",
]);

/** npm package name shape, scoped or plain. */
const PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

const GHSA = /GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}/i;

/**
 * Pull advisories out of whatever shape the manager produced.
 *
 * Every node in the tree is examined for the three facts that matter. A node contributes an
 * advisory only when all three are present, so partial structures are skipped rather than guessed
 * at — and the caller can tell "no advisories" from "could not read the output" by the count.
 */
export function parseAuditJson(text: string): Advisory[] {
  const found = new Map<string, Advisory>();

  const visit = (node: unknown, inheritedPackage?: string, inheritedSeverity?: Severity): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, inheritedPackage, inheritedSeverity);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const obj = node as Record<string, unknown>;

    const pkg =
      (typeof obj.module_name === "string" && obj.module_name) ||
      (typeof obj.name === "string" && obj.name) ||
      (typeof obj.package === "string" && obj.package) ||
      inheritedPackage;
    const severity = normaliseSeverity(obj.severity) ?? inheritedSeverity;

    const idSource = [obj.github_advisory_id, obj.ghsa_id, obj.url, obj.id, obj.source, obj.cve]
      .map((v) => (typeof v === "string" ? v : ""))
      .find((v) => GHSA.test(v));
    const id = idSource ? (GHSA.exec(idSource)?.[0].toUpperCase() ?? null) : null;

    if (id && pkg && severity) {
      const title =
        (typeof obj.title === "string" && obj.title) ||
        (typeof obj.overview === "string" && obj.overview.slice(0, 120)) ||
        "";
      // Keep the first sighting: the outermost node carries the package the repo depends on,
      // while deeper `via` chains name transitive hops.
      if (!found.has(id)) found.set(id, { id, package: pkg, severity, title });
    }

    for (const [key, value] of Object.entries(obj)) {
      // A key that looks like a package name IS the package name for everything under it — that is
      // bun's whole shape. Structural keys are excluded so npm's wrapper objects do not become
      // packages.
      const keyAsPackage =
        !STRUCTURAL_KEYS.has(key) &&
        PACKAGE_NAME.test(key) &&
        typeof value === "object" &&
        value !== null
          ? key
          : undefined;
      visit(value, keyAsPackage ?? pkg, severity);
    }
  };

  // Some managers emit one JSON document per line (yarn berry). Try the whole text first, then
  // fall back to line-by-line so a single malformed line cannot blind the rest.
  try {
    visit(JSON.parse(text));
  } catch {
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        visit(JSON.parse(trimmed));
      } catch {
        /* not this line */
      }
    }
  }

  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export interface BaselineDiff {
  /** In the audit, not in the baseline: what the gate fails on. */
  added: Advisory[];
  /** In the baseline, no longer in the audit: the file must shrink, so this is also an error. */
  stale: Array<{ id: string } & Omit<Advisory, "id">>;
  /** Everything still present and known, counted per severity. */
  remaining: Record<Severity, number>;
}

export function diffAgainstBaseline(current: Advisory[], baseline: Baseline): BaselineDiff {
  const known = baseline.advisories ?? {};
  const currentIds = new Set(current.map((a) => a.id));

  const remaining: Record<Severity, number> = {
    critical: 0,
    high: 0,
    moderate: 0,
    low: 0,
    info: 0,
  };
  const added: Advisory[] = [];
  for (const advisory of current) {
    if (known[advisory.id]) remaining[advisory.severity] += 1;
    else added.push(advisory);
  }

  const stale = Object.entries(known)
    .filter(([id]) => !currentIds.has(id))
    .map(([id, entry]) => ({ id, ...entry }));

  return { added, stale, remaining };
}

/** The highest severity in a set, for the check's own severity field. */
export function worstSeverity(advisories: Advisory[]): Severity | null {
  for (const s of SEVERITY_ORDER) if (advisories.some((a) => a.severity === s)) return s;
  return null;
}

/** A one-line summary of remaining debt, so the size is visible without opening the file. */
export function describeRemaining(remaining: Record<Severity, number>): string {
  const parts = SEVERITY_ORDER.filter((s) => remaining[s] > 0).map((s) => `${remaining[s]} ${s}`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

export async function readBaseline(root: string): Promise<Baseline | null> {
  try {
    const parsed = JSON.parse(
      await readFile(join(root, ADVISORY_BASELINE_FILE), "utf-8"),
    ) as Baseline | null;
    if (!parsed || typeof parsed !== "object" || typeof parsed.advisories !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Serialise the baseline with sorted ids and no timestamp.
 *
 * No `generatedAt`: a timestamp turns every accept into a diff even when the data is identical,
 * and this file exists to make dependency changes readable in review.
 */
export function renderBaseline(advisories: Advisory[]): string {
  const sorted = [...advisories].sort((a, b) => a.id.localeCompare(b.id));
  const body: Baseline["advisories"] = {};
  for (const a of sorted) body[a.id] = { package: a.package, severity: a.severity, title: a.title };
  return `${JSON.stringify({ advisories: body }, null, 2)}\n`;
}

export async function writeBaseline(root: string, advisories: Advisory[]): Promise<void> {
  await mkdir(join(root, ".kit"), { recursive: true });
  await writeFile(join(root, ADVISORY_BASELINE_FILE), renderBaseline(advisories), "utf-8");
}

export interface AuditOutcome {
  advisories: Advisory[];
  /** Set when the audit could not produce a readable result — never treated as "clean". */
  error?: string;
  manager: string;
}

/**
 * Run the manager's audit and parse it.
 *
 * A non-zero exit is normal — npm audit exits non-zero when it finds anything — so the exit code is
 * not the signal. The signal is whether the output parsed into advisories: no advisories AND no
 * parseable JSON means the audit did not run, and that must not read as a clean result.
 */
export function runAudit(root: string, runner: AuditRunner): AuditOutcome {
  const [bin, ...args] = runner.command;
  const r = spawnSync(bin, args, {
    cwd: root,
    encoding: "utf-8",
    timeout: 180_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (r.error) return { advisories: [], error: r.error.message, manager: runner.manager };
  const out = r.stdout ?? "";
  const advisories = parseAuditJson(out);
  if (advisories.length === 0) {
    const looksLikeJson = out.trimStart().startsWith("{") || out.trimStart().startsWith("[");
    if (!looksLikeJson) {
      return {
        advisories: [],
        error: `${runner.manager} audit produced no JSON (${(r.stderr ?? "").trim().slice(0, 80) || `exit ${r.status}`})`,
        manager: runner.manager,
      };
    }
  }
  return { advisories, manager: runner.manager };
}
