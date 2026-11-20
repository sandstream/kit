/**
 * Changes to the user-level agent files since kit last saw them.
 *
 * kit-research `theo-t3-ten-videos-vs-kit`: skills in `~/.claude/skills` are often synced to every
 * machine by a script nobody reads, or rewritten by an agent, and no repository history records
 * the change. `kit agent-audit` scans their content; this records a sha256 per file in
 * `~/.kit/user-surfaces.json` and reports added, changed and removed files until a person accepts
 * them with `kit agent-audit --accept-user-surfaces`. The baseline lives under `~/.kit`, which the
 * gates refuse to let an agent's own tools write (trail-guard).
 *
 * The first run records the baseline and says so. In read-only mode nothing is written.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { userSurfaceFiles } from "./agent-audit-user.js";
import type { SecurityCheckResult } from "./check-security.js";
import { readInstructionFile } from "./instruction-scan.js";

const NAME = "user-level agent files since last accepted";
const ACCEPT = "kit agent-audit --accept-user-surfaces";

export function baselinePath(home: string): string {
  return join(home, ".kit", "user-surfaces.json");
}

/** sha256 per user-level agent file, keyed by how it is shown (`~/.claude/skills/…`). */
function surfaceDigests(home: string, env: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of userSurfaceFiles(home, env)) {
    const body = readInstructionFile(f.abs);
    if (body !== null) out[f.shown] = createHash("sha256").update(body).digest("hex");
  }
  return out;
}

function readBaseline(home: string): Record<string, string> | null {
  try {
    const parsed = JSON.parse(readFileSync(baselinePath(home), "utf-8")) as {
      files?: Record<string, string>;
    };
    return parsed.files && typeof parsed.files === "object" ? parsed.files : null;
  } catch {
    return null;
  }
}

function writeBaseline(home: string, files: Record<string, string>): void {
  const path = baselinePath(home);
  mkdirSync(dirname(path), { recursive: true });
  const body = JSON.stringify({ version: 1, files }, null, 2) + "\n";
  writeFileSync(path, body, { encoding: "utf-8", mode: 0o600 });
}

export interface SurfaceDrift {
  added: string[];
  changed: string[];
  removed: string[];
}

/** What differs between a baseline and the current digests. Pure. */
export function diffSurfaces(
  before: Record<string, string>,
  now: Record<string, string>,
): SurfaceDrift {
  const keys = (o: Record<string, string>) => Object.keys(o).sort();
  return {
    added: keys(now).filter((k) => !(k in before)),
    changed: keys(now).filter((k) => k in before && before[k] !== now[k]),
    removed: keys(before).filter((k) => !(k in now)),
  };
}

function listed(d: SurfaceDrift): string {
  const all = [
    ...d.changed.map((k) => `changed ${k}`),
    ...d.added.map((k) => `added ${k}`),
    ...d.removed.map((k) => `removed ${k}`),
  ];
  const more = all.length > 8 ? ` and ${all.length - 8} more` : "";
  return all.slice(0, 8).join("; ") + more;
}

/**
 * The drift row. `record` allows writing the first baseline (false in read-only mode). Never
 * updates an existing baseline: only a person accepting does.
 */
export function userSurfaceDriftRows(
  home: string,
  env: Record<string, unknown>,
  record: boolean,
): SecurityCheckResult[] {
  const now = surfaceDigests(home, env);
  const before = readBaseline(home);
  const base = { category: "exposure", name: NAME } as const;
  if (before === null) {
    if (Object.keys(now).length === 0) return [];
    if (!record) {
      return [
        { ...base, status: "skip", detail: "no baseline yet, and read-only mode writes none" },
      ];
    }
    writeBaseline(home, now);
    return [
      {
        ...base,
        status: "pass",
        detail: `baseline recorded for ${Object.keys(now).length} user-level agent file(s); later changes are reported until \`${ACCEPT}\``,
      },
    ];
  }
  const d = diffSurfaces(before, now);
  const n = d.added.length + d.changed.length + d.removed.length;
  if (n === 0) {
    return [{ ...base, status: "pass", detail: `${Object.keys(now).length} file(s) unchanged` }];
  }
  return [
    {
      ...base,
      status: "warn",
      severity: "medium",
      hasFindings: true,
      detail: `${n} user-level agent file(s) differ from the accepted baseline, loaded into every session on this machine: ${listed(d)}`,
      suggestion: `read them; if you made or expected these changes, run \`${ACCEPT}\` yourself`,
    },
  ];
}

/** Record the current files as accepted. Returns how many. */
export function acceptUserSurfaces(home: string, env: Record<string, unknown>): number {
  const now = surfaceDigests(home, env);
  writeBaseline(home, now);
  return Object.keys(now).length;
}
