/**
 * kit knobs — a curated reference of the power-user env vars + `.kit.toml` fields
 * that kit honors but that aren't part of the everyday surface. Surfaced by
 * `kit config knobs` so they're DISCOVERABLE without reading source.
 *
 * This is documentation-as-data: a single hand-curated list (only user-facing,
 * genuinely useful knobs — internal/test-only env vars are intentionally left
 * out). Pure: `formatKnobs` renders it; `knobsAsJson` returns it structured.
 */
import { c } from "./utils/colors.js";

export interface Knob {
  /** Env var name, or `.kit.toml` key path. */
  name: string;
  kind: "env" | "config";
  /** One-line explanation. */
  desc: string;
  /** Bypasses a safety gate — render with a warning. */
  danger?: boolean;
}

export interface KnobGroup {
  title: string;
  knobs: Knob[];
}

export const KNOBS: KnobGroup[] = [
  {
    title: "Scanning & supply-chain",
    knobs: [
      {
        name: "KIT_SEMGREP_CONFIG",
        kind: "env",
        desc: "semgrep ruleset — a LOCAL path (e.g. ./rules.yaml) enables air-gapped SAST; default p/default fetches from the registry",
      },
      {
        name: "KIT_BUMBLEBEE_PROFILE",
        kind: "env",
        desc: "supply-chain scan depth: baseline (fast, default) | project | deep",
      },
      {
        name: "KIT_BUMBLEBEE_REQUIRED",
        kind: "env",
        desc: "fail the gate if the bumblebee scanner is unavailable (regulated/strict)",
      },
      {
        name: "KIT_NO_DOWNLOAD",
        kind: "env",
        desc: "never download scanner binaries — use only what's already installed",
      },
      {
        name: "[scan].guarddog",
        kind: "config",
        desc: "enable GuardDog malware heuristics (needs semgrep); off by default",
      },
      {
        name: "[supply_chain].internal_scopes",
        kind: "config",
        desc: "npm orgs / PyPI namespaces treated as internal — skipped in triage (monorepo whitelist)",
      },
    ],
  },
  {
    title: "Memory",
    knobs: [
      {
        name: "KIT_MEMORY_REDACT",
        kind: "env",
        desc: "mask secret-shaped values BEFORE they're written to memory.db (spillage prevention)",
      },
      {
        name: "KIT_MEMORY_DIR",
        kind: "env",
        desc: "relocate the store (default ~/.kit) — put it outside any repo for cross-device sync",
      },
      {
        name: "KIT_MEMORY_PASSPHRASE",
        kind: "env",
        desc: "AES-256-GCM passphrase for `kit memory backup`/`push`/`pull` — never stored",
      },
      {
        name: "[memory].track_findings",
        kind: "config",
        desc: "auto-track `kit check` findings as PAL items that close on re-scan (default true)",
      },
      {
        name: "[memory.sync]",
        kind: "config",
        desc: "cross-device sync (in ~/.kit/sync.toml) — set it up with `kit memory sync init`",
      },
    ],
  },
  {
    title: "Policy & governance",
    knobs: [
      {
        name: "[policy].default_mode",
        kind: "config",
        desc: '"read-only" locks the repo to read-only without a CLI flag',
      },
      {
        name: "[policy.agent_writes]",
        kind: "config",
        desc: 'pre-authorize specific agent vendor ops (e.g. sentry = ["resolve_issue"])',
      },
      {
        name: "KIT_READ_ONLY",
        kind: "env",
        desc: "refuse all writes / mutations / elevation — agent containment",
      },
    ],
  },
  {
    title: "Audit & attestation",
    knobs: [
      {
        name: "KIT_ATTEST",
        kind: "env",
        desc: "emit a signed gate-attestation receipt (same as `kit check --attest`)",
      },
      {
        name: "KIT_AUDIT_ANCHOR_DIR",
        kind: "env",
        desc: "relocate the HMAC audit-anchor key + record (default ~/.kit)",
      },
    ],
  },
  {
    title: "Init & setup",
    knobs: [
      {
        name: "KIT_DEFAULTS_FILE",
        kind: "env",
        desc: "path override for ~/.kit/defaults.toml — user-level [init] services kit init always merges in (your standing preferences, e.g. sentry + posthog)",
      },
    ],
  },
  {
    title: "CI & automation — use with care",
    knobs: [
      {
        name: "KIT_CI_STRICT",
        kind: "env",
        desc: "fail `kit ci` if any scanner is unavailable (same as --strict)",
      },
      {
        name: "KIT_NO_UPDATE_CHECK",
        kind: "env",
        desc: "disable the outbound version notices — kit's own npm check and the pinned-scanner release check (reproducible/offline CI)",
      },
      {
        name: "KIT_AIRGAP",
        kind: "env",
        desc: "air-gap mode: no outbound network; cloud-only scanners are dropped",
      },
      {
        name: "KIT_NO_HINTS",
        kind: "env",
        desc: "silence the 💡 contextual tips",
      },
      {
        name: "KIT_NON_INTERACTIVE",
        kind: "env",
        desc: "skip ALL confirmation prompts",
        danger: true,
      },
      {
        name: "KIT_ELEVATED",
        kind: "env",
        desc: "bypass the TTY elevation gate for destructive ops in CI (always audit-logged)",
        danger: true,
      },
      {
        name: "KIT_PROD_OK",
        kind: "env",
        desc: "allow production-secret operations without interactive confirmation",
        danger: true,
      },
    ],
  },
  {
    title: "TLS monitoring",
    knobs: [
      {
        name: "KIT_TLS_HOST",
        kind: "env",
        desc: "comma-separated hosts → certificate-expiry monitoring in `kit check`",
      },
      {
        name: "KIT_TLS_WARN_DAYS",
        kind: "env",
        desc: "days-to-expiry warning threshold (default 21)",
      },
    ],
  },
];

/** Structured form for `--json`. */
export function knobsAsJson(): KnobGroup[] {
  return KNOBS;
}

/** Human-readable, grouped rendering. `color` toggles ANSI. */
export function formatKnobs(opts: { color?: boolean } = {}): string {
  const color = opts.color ?? true;
  const paint = (fn: string, s: string) => (color ? `${fn}${s}${c.reset}` : s);
  const lines: string[] = [];
  lines.push(paint(c.bold, "kit knobs — power-user env vars + .kit.toml fields"));
  lines.push(
    paint(c.dim, "env = environment variable · cfg = .kit.toml key · ⚠ = bypasses a safety gate"),
  );
  const width = Math.max(...KNOBS.flatMap((g) => g.knobs.map((k) => k.name.length)));
  for (const group of KNOBS) {
    lines.push("");
    lines.push(paint(c.cyan, group.title));
    for (const k of group.knobs) {
      const tag = k.kind === "env" ? "env" : "cfg";
      const flag = k.danger ? paint(c.yellow, " ⚠") : "";
      const name = k.name.padEnd(width);
      lines.push(`  ${paint(c.dim, tag)} ${paint(c.bold, name)}  ${paint(c.dim, k.desc)}${flag}`);
    }
  }
  return lines.join("\n");
}
