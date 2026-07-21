/**
 * Obsidian export (J3) — render the curated shared-memory tier as an Obsidian-
 * flavored markdown vault: one note per entry (YAML frontmatter + body + refs +
 * `[[wikilinks]]` for supersede/reverse relations), plus a per-area index (MOC).
 *
 * Pure + deterministic (entries → files; no IO, no clock). The command layer does
 * the writing. Export is read-only over already-secret-scanned curated entries, so
 * it never re-introduces a secret (they are refused at share time).
 */
import type { SharedEntry, SharedStatus } from "./shared.js";
import { effectiveStatus } from "./shared.js";

export interface ObsidianFile {
  /** Vault-relative path, POSIX separators. */
  path: string;
  content: string;
}

/** Filesystem-safe slug for a title (display stays in frontmatter/H1). */
export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "untitled"
  );
}

/** Stable note basename for an entry (unique by id; collision-free). */
function noteBase(e: SharedEntry): string {
  return `${e.kind}-${e.id}-${slugify(e.title)}`;
}

function yamlFrontmatter(fields: Record<string, string | string[] | undefined>): string {
  const lines: string[] = ["---"];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${yamlScalar(item)}`);
    } else {
      lines.push(`${k}: ${yamlScalar(v)}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

/** Quote a scalar when it could confuse the YAML parser; otherwise leave bare. */
function yamlScalar(v: string): string {
  return /^[\w.@/+-]+$/.test(v) ? v : JSON.stringify(v);
}

/**
 * Render the whole tier to a deterministic set of vault files. Notes are grouped
 * under `area/`; each area also gets an `_index.md` MOC linking its entries.
 * `now`-free: status is computed from the entry set, not the clock.
 */
export function renderObsidianVault(entries: SharedEntry[]): ObsidianFile[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const wikilink = (id: string): string => {
    const target = byId.get(id);
    return target ? `[[${noteBase(target)}]]` : `\`${id}\` (missing)`;
  };

  const files: ObsidianFile[] = [];
  // Sort for deterministic output: area, then ts, then id.
  const sorted = [...entries].sort(
    (a, b) => a.area.localeCompare(b.area) || a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id),
  );

  for (const e of sorted) {
    const status: SharedStatus = effectiveStatus(e, entries);
    const fm = yamlFrontmatter({
      id: e.id,
      area: e.area,
      kind: e.kind,
      status,
      provenance: e.provenance ?? "operator",
      confidence: e.confidence,
      author: e.author,
      ts: e.ts,
      source_ref: e.source_ref,
      tags: ["kit/shared", `kit/kind/${e.kind}`, `kit/area/${e.area}`],
    });
    const rel: string[] = [];
    if (e.supersedes) rel.push(`> Supersedes ${wikilink(e.supersedes)}`);
    if (e.reverses) rel.push(`> Reverses ${wikilink(e.reverses)}`);
    const body = [
      fm,
      "",
      `# ${e.title}`,
      status !== "active" ? `\n> [!warning] ${status}\n` : "",
      rel.length ? rel.join("\n") + "\n" : "",
      e.body || "",
      e.refs.length ? `\n## Refs\n${e.refs.map((r) => `- ${r}`).join("\n")}` : "",
      "",
      `---\n*Exported from kit shared memory · area [[_index|${e.area}]]*`,
      "",
    ]
      .filter((s) => s !== "")
      .join("\n");
    files.push({ path: `${e.area}/${noteBase(e)}.md`, content: body.replace(/\n{3,}/g, "\n\n") });
  }

  // Per-area index (MOC).
  const areas = [...new Set(sorted.map((e) => e.area))].sort();
  for (const area of areas) {
    const inArea = sorted.filter((e) => e.area === area);
    const lines = [
      yamlFrontmatter({ area, tags: ["kit/shared", "kit/moc", `kit/area/${area}`] }),
      "",
      `# ${area}`,
      "",
      `${inArea.length} shared entr${inArea.length === 1 ? "y" : "ies"}.`,
      "",
      ...inArea.map((e) => {
        const st = effectiveStatus(e, entries);
        const badge = st === "active" ? "" : ` _(${st})_`;
        return `- [[${noteBase(e)}|${e.title}]] · \`${e.kind}\`${badge}`;
      }),
      "",
    ];
    files.push({ path: `${area}/_index.md`, content: lines.join("\n") });
  }

  return files;
}
