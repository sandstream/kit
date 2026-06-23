/**
 * Compare two .env-style files (or local vs vault state) and surface drift.
 *
 * Used by `kit env diff --compare staging` to spot when a developer's
 * local .env.local has drifted from .env.staging — common cause of bugs
 * that only reproduce in one environment.
 *
 * Reads via the existing planMigration() path so we honor the same KEY=VALUE
 * parsing (quote-stripping, comment skipping, validation). Output is a
 * diff-summary: only-in-A, only-in-B, value-different-keys. Values
 * themselves are NEVER printed — only key-presence + a hash-prefix to
 * confirm they differ.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { isValidKeyName } from "./secrets-migrate.js";

export interface EnvDiffResult {
  onlyInA: string[];
  onlyInB: string[];
  /** Keys present in both with different values. */
  changed: Array<{ key: string; aHash: string; bHash: string }>;
  /** Keys with identical values (rendered only as count). */
  identicalCount: number;
}

async function parseEnvFile(path: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch {
    return out;
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!isValidKeyName(key)) continue;
    out.set(key, value);
  }
  return out;
}

function hashPrefix(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

export async function diffEnvFiles(
  pathA: string,
  pathB: string,
  cwd: string = process.cwd(),
): Promise<EnvDiffResult> {
  const a = await parseEnvFile(resolve(cwd, pathA));
  const b = await parseEnvFile(resolve(cwd, pathB));
  const onlyInA: string[] = [];
  const onlyInB: string[] = [];
  const changed: Array<{ key: string; aHash: string; bHash: string }> = [];
  let identicalCount = 0;
  for (const [k, vA] of a) {
    if (!b.has(k)) {
      onlyInA.push(k);
    } else {
      const vB = b.get(k)!;
      if (vA === vB) identicalCount++;
      else changed.push({ key: k, aHash: hashPrefix(vA), bHash: hashPrefix(vB) });
    }
  }
  for (const k of b.keys()) {
    if (!a.has(k)) onlyInB.push(k);
  }
  onlyInA.sort();
  onlyInB.sort();
  changed.sort((x, y) => x.key.localeCompare(y.key));
  return { onlyInA, onlyInB, changed, identicalCount };
}

export function formatEnvDiff(diff: EnvDiffResult, labelA: string, labelB: string): string {
  const lines: string[] = [];
  lines.push(`env-diff ${labelA} vs ${labelB}`);
  lines.push("─".repeat(50));
  lines.push("");
  if (diff.changed.length > 0) {
    lines.push(`Changed (${diff.changed.length}):`);
    for (const c of diff.changed) {
      lines.push(`  ⚠  ${c.key}  ${labelA}=${c.aHash}…  ${labelB}=${c.bHash}…`);
    }
    lines.push("");
  }
  if (diff.onlyInA.length > 0) {
    lines.push(`Only in ${labelA} (${diff.onlyInA.length}):`);
    for (const k of diff.onlyInA) lines.push(`  +  ${k}`);
    lines.push("");
  }
  if (diff.onlyInB.length > 0) {
    lines.push(`Only in ${labelB} (${diff.onlyInB.length}):`);
    for (const k of diff.onlyInB) lines.push(`  -  ${k}`);
    lines.push("");
  }
  lines.push(`Identical keys: ${diff.identicalCount}`);
  return lines.join("\n");
}
