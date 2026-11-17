/**
 * How the `documented env vars` self-audit rule (self-audit-docs.ts) finds the `KIT_*` names the
 * implementation reads or sets, by file type. The oracle is deliberately generous, to stay sound:
 * a name counts as known if TypeScript reads it via `process.env.X` or a destructured `env.X` (how
 * `airgap/config.ts` reads its vars) or sets it for a child process or hook; if bash expands it;
 * or if the bundled skills' Python reads it from `os.environ` (triage.py and docker_label.py read
 * their registry overrides that way). Tests do not count: a test must not make the claim true.
 */
const TS_PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]{2,60})/g,
  /process\.env\[["'`]([A-Z][A-Z0-9_]{2,60})/g,
  /\benv\.([A-Z][A-Z0-9_]{2,60})/g,
  /["'`](KIT_[A-Z0-9_]{2,60})["'`]\s*[:=,;)\]]/g,
  /\b(KIT_[A-Z0-9_]{2,60})\s*[:=]/g,
];
const SH_PATTERNS = [/\$\{?(KIT_[A-Z0-9_]{2,60})\b/g]; // bash: $KIT_X or ${KIT_X:-…}
const PY_PATTERNS = [
  /os\.environ(?:\.get\(|\[)\s*["'](KIT_[A-Z0-9_]{2,60})["']/g,
  /["'](KIT_[A-Z0-9_]{2,60})["']\s+(?:not\s+)?in\s+os\.environ/g,
];

/** The patterns for a file name, or null for a file that is not scanned (another type, or a test). */
export function envReadPatterns(name: string): RegExp[] | null {
  if (/\.test\.(ts|mjs)$|^test_.*\.py$/.test(name)) return null;
  if (name.endsWith(".py")) return PY_PATTERNS;
  if (name.endsWith(".sh")) return SH_PATTERNS;
  return /\.(ts|mjs)$/.test(name) ? TS_PATTERNS : null;
}
