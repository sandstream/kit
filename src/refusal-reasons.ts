/**
 * Refusals grouped by the wall they hit, not only by the gate that refused.
 *
 * `kit usage` counted refusals per gate (`gate-fs 4`). In practice one cause dominates: in the
 * scratch project of kit-research `agent-platform-2027-vs-kit`, all four `gate-fs` refusals had
 * the same reason, an unsigned scope, which one `kit profile sign` by the scope's owner clears.
 * kit-research `read-where-agents-fail-vs-kit` (after a post where 19 of 23 failed connections hit
 * one admin approval) asks for that view: read where agents fail before writing more rules.
 *
 * A reason is reduced to its shape by deterministic substitutions, so refusals that differ only in
 * a path, host, package, version, quoted value or number fall into one group. No model reads the text.
 */

const FILE_EXTENSIONS = new Set([
  "json",
  "toml",
  "md",
  "yml",
  "yaml",
  "ts",
  "js",
  "mjs",
  "txt",
  "lock",
  "env",
  "sh",
  "py",
]);

/**
 * A dotted number is a version (`1.3.0`, `v2.1`, `1.0.0-beta.1`), not a host, unless it is exactly
 * four octets of 0-255 with no prefix or suffix: that is an IPv4 address and stays `<host>`. A
 * dotted number followed by more labels (`10.0.0.1.nip.io`) is not matched here at all, so the
 * host rule below takes the whole name.
 */
const DOTTED_NUMBER =
  /\bv?\d+(?:\.\d+){1,3}(?:-[0-9a-z]+(?:\.[0-9a-z]+)*)?(?:\+[0-9a-z.]+)?(?![.\w-])/gi;

function versionOrIpv4(m: string): string {
  const octets = m.split(".");
  const ipv4 = octets.length === 4 && octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255);
  return ipv4 ? "<host>" : "<version>";
}

const RULES: Array<[RegExp, string | ((m: string) => string)]> = [
  [/`[^`]*`/g, "<…>"],
  [/"[^"]*"|'[^']*'/g, "<…>"],
  [/\bhttps?:\/\/\S+/g, "<url>"],
  // A path starts a word: "scope/RoE" is not one.
  [/(^|[\s(=])(?:\[REDACTED\]|~|\.{1,2})?(?:\/[^\s,;:()]+)+/g, "$1<path>"],
  [/\b[A-Za-z]:\\[^\s,;()]+/g, "<path>"],
  [/\b[a-z][a-z0-9-]*:[^\s,;()]+/gi, "<target>"],
  [DOTTED_NUMBER, versionOrIpv4],
  [
    /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi,
    (m) => (FILE_EXTENSIONS.has(m.split(".").pop()?.toLowerCase() ?? "") ? m : "<host>"),
  ],
  [/\([^()]*\)/g, "(…)"],
  [/\b\d+\b/g, "<n>"],
  [/<host>(?:,\s*<host>)+/g, "<host>"],
  [/<target>(?:,\s*<target>)+/g, "<target>"],
];

/** The shape of a refusal reason: variable parts replaced, whitespace collapsed, at most 160 characters. Pure. */
export function reasonShape(reason: string): string {
  let shape = reason.split("\n")[0] ?? "";
  for (const [re, by] of RULES) shape = shape.replace(re, by as string);
  shape = shape.replace(/\s+/g, " ").trim();
  return shape.length > 160 ? `${shape.slice(0, 157)}...` : shape || "(no reason given)";
}

export interface ReasonGroup {
  operation: string;
  reason: string;
  count: number;
}

/** Refusals grouped by gate and reason shape, most frequent first, at most `limit`. Pure. */
export function groupRefusals(
  refusals: Array<{ operation?: unknown; error?: unknown }>,
  limit = 6,
): ReasonGroup[] {
  const groups = new Map<string, ReasonGroup>();
  for (const r of refusals) {
    const operation = typeof r.operation === "string" ? r.operation : "(unnamed)";
    const reason = reasonShape(typeof r.error === "string" ? r.error : "");
    const key = `${operation}\n${reason}`;
    const g = groups.get(key) ?? { operation, reason, count: 0 };
    g.count++;
    groups.set(key, g);
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count || a.operation.localeCompare(b.operation))
    .slice(0, limit);
}
