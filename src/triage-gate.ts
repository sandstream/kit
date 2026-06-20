/**
 * Triage gate — kit installs NOTHING untriaged.
 *
 * Every third-party tool/package kit would install (mise scanners pinned as
 * `aqua:`/`npm:`/`pipx:` refs, etc.) is run through `kit triage` first. Only an
 * explicit triage PASS lets an install proceed. This is WATERTIGHT / fail-closed:
 * a WARN, a FAIL, an offline triage, a missing triage script, or a ref we cannot
 * map to a triage target ALL block the install. The only escape is an explicit
 * `--no-triage` override at the command layer, which itself requires elevation
 * and is audit-logged — heal never takes that escape.
 *
 * Core language runtimes (bare mise names like `node`, `pnpm`) are the trusted
 * base: mise installs them from its registry with checksum verification, and
 * they are the language floor kit itself runs on. They pass without a reputation
 * triage. Anything carrying a `scheme:` (a third-party package/binary) is the
 * supply-chain surface and is always triaged.
 */
import { runTriage, type TriageType, type TriageResult } from "./triage.js";

/** Core language runtimes managed by mise core — the trusted base, not triaged. */
export const CORE_RUNTIMES = new Set([
  "node", "nodejs", "pnpm", "npm", "yarn", "bun", "deno",
  "python", "python3", "go", "golang", "ruby", "java", "openjdk",
  "rust", "cargo", "dotnet", "php", "zig", "elixir", "erlang",
]);

export type TriageMapping =
  | { kind: "runtime" }
  | { kind: "triage"; type: TriageType; target: string }
  | { kind: "untriageable"; ref: string };

/** Extract `owner/repo` from `owner/repo`, a github URL, or a `host/owner/repo`. */
function extractOwnerRepo(rest: string): string | null {
  const cleaned = rest
    .replace(/^https?:\/\//, "")
    .replace(/^github\.com\//, "")
    .replace(/\.git$/, "");
  const m = cleaned.match(/([^/\s]+\/[^/\s@]+)/);
  return m ? m[1] : null;
}

/**
 * Map a mise tool identifier to a triage (type, target), mark it a trusted core
 * runtime, or mark it untriageable (→ the gate will fail-closed on it). PURE.
 */
export function triageTargetFor(tool: string): TriageMapping {
  const ref = tool.trim();
  if (!ref.includes(":")) {
    return CORE_RUNTIMES.has(ref.toLowerCase()) ? { kind: "runtime" } : { kind: "untriageable", ref };
  }
  const idx = ref.indexOf(":");
  const scheme = ref.slice(0, idx).toLowerCase();
  const rest = ref.slice(idx + 1);
  if (scheme === "npm") return { kind: "triage", type: "npm", target: rest };
  if (scheme === "pip" || scheme === "pipx") return { kind: "triage", type: "pip", target: rest };
  // Everything else that names a repo (aqua/ubi/go/github/cargo/...) → repo triage.
  const ownerRepo = extractOwnerRepo(rest);
  if (ownerRepo) return { kind: "triage", type: "repo", target: `https://github.com/${ownerRepo}` };
  return { kind: "untriageable", ref };
}

export interface GateVerdict {
  tool: string;
  decision: "pass" | "blocked";
  reason: string;
  triageType?: TriageType;
  triageTarget?: string;
}

export interface GateDeps {
  runTriage: (type: TriageType, target: string) => Promise<TriageResult>;
}

const defaultDeps: GateDeps = { runTriage };

/** First non-empty line of triage output, for a compact block reason. */
function firstLine(output: string): string {
  return output.split("\n").map((l) => l.trim()).find(Boolean) ?? "no triage output";
}

/**
 * Watertight gate: returns `pass` ONLY for a trusted core runtime or an explicit
 * triage PASS. WARN / FAIL / offline / missing-script / unmappable-ref all return
 * `blocked` (fail-closed).
 */
export async function gateInstall(tool: string, deps: GateDeps = defaultDeps): Promise<GateVerdict> {
  const t = triageTargetFor(tool);
  if (t.kind === "runtime") {
    return { tool, decision: "pass", reason: "core language runtime (trusted base)" };
  }
  if (t.kind === "untriageable") {
    return {
      tool,
      decision: "blocked",
      reason: `no triage path for "${t.ref}" — cannot verify, refusing to install (fail-closed)`,
    };
  }
  const res = await deps.runTriage(t.type, t.target);
  if (res.passed) {
    return {
      tool,
      decision: "pass",
      reason: `triage passed (${t.type} ${t.target})`,
      triageType: t.type,
      triageTarget: t.target,
    };
  }
  return {
    tool,
    decision: "blocked",
    reason: `triage did not pass (${t.type} ${t.target}): ${firstLine(res.output)}`,
    triageType: t.type,
    triageTarget: t.target,
  };
}
