/**
 * Setup modes — named presets over kit's orthogonal setup knobs (install / login /
 * secrets / hooks / recommended hardening / network posture / read-only). A "mode"
 * is just a bundle of those switches, so `kit setup --mode <name>` (or `[setup].mode`
 * in .kit.toml) gives a one-word way to say "full machine bootstrap" vs "air-gapped
 * enclave" vs "read-only review of an untrusted repo" — and `kit status` scores
 * progress against the mode's expected subsystems.
 *
 * Pure + data-driven so it is fully fixture-testable and agent-agnostic (no harness
 * coupling): the same modes mean the same thing under Claude Code, Codex, Cursor,
 * Aider, Gemini, or a bare shell.
 */

export type SetupMode = "full" | "local" | "airgap" | "ci" | "agent" | "review" | "minimal";

/** Subsystems kit can set up; `kit status` scores the ones a mode `expects`. */
export type SubsystemKey =
  | "config"
  | "tools"
  | "secrets"
  | "hooks"
  | "agent-config"
  | "memory"
  | "posture";

export interface ModeProfile {
  mode: SetupMode;
  label: string;
  /** install declared [tools] via mise */
  install: boolean;
  /** guided service logins */
  login: boolean;
  /** materialize .env.local from the vault */
  secrets: boolean;
  /** wire git hooks */
  hooks: boolean;
  /** recommended hardening (cross-harness memory hooks + git secret-scan/context-check gates) */
  recommended: boolean;
  /** network posture to write to [air_gap]; null = leave to the interactive posture prompt */
  posture: "connected" | "airgap" | null;
  /** force read-only for the whole run — no installs/logins/writes (untrusted-repo review) */
  readOnly: boolean;
  /** subsystems `kit status` counts toward this mode's completion score */
  expects: SubsystemKey[];
  /** one-line description for help / status */
  blurb: string;
}

export const MODES: Record<SetupMode, ModeProfile> = {
  full: {
    mode: "full",
    label: "full",
    install: true,
    login: true,
    secrets: true,
    hooks: true,
    recommended: true,
    posture: null,
    readOnly: false,
    expects: ["config", "tools", "secrets", "hooks", "agent-config", "memory"],
    blurb: "everything on — tools, logins, secrets, hooks, memory (new machine)",
  },
  local: {
    mode: "local",
    label: "local",
    install: true,
    login: true,
    secrets: true,
    hooks: true,
    recommended: false,
    posture: "connected",
    readOnly: false,
    expects: ["config", "tools", "secrets", "hooks"],
    blurb: "daily dev — tools + secrets + hooks (prod keys stay env-gated)",
  },
  airgap: {
    mode: "airgap",
    label: "airgap",
    install: true,
    login: false,
    secrets: true,
    hooks: true,
    recommended: false,
    posture: "airgap",
    readOnly: false,
    expects: ["config", "tools", "secrets", "hooks", "posture"],
    blurb: "no-egress enclave — local scanners only, cloud (Snyk/Socket) dropped",
  },
  ci: {
    mode: "ci",
    label: "ci",
    install: true,
    login: false,
    secrets: true,
    hooks: false,
    recommended: false,
    posture: "connected",
    readOnly: false,
    expects: ["config", "secrets"],
    blurb: "CI/runner — non-interactive, vault-token secrets, no prompts",
  },
  agent: {
    mode: "agent",
    label: "agent",
    install: false,
    login: false,
    secrets: true,
    hooks: true,
    recommended: true,
    posture: "connected",
    readOnly: false,
    expects: ["config", "secrets", "hooks", "agent-config", "memory"],
    blurb: "AI-agent runner (gastown/ruflo) — governed: gates + memory, no installs",
  },
  review: {
    mode: "review",
    label: "review",
    install: false,
    login: false,
    secrets: false,
    hooks: false,
    recommended: false,
    posture: null,
    readOnly: true,
    expects: ["config"],
    blurb: "read-only audit of an untrusted repo — zero writes/installs/logins",
  },
  minimal: {
    mode: "minimal",
    label: "minimal",
    install: false,
    login: false,
    secrets: true,
    hooks: true,
    recommended: false,
    posture: null,
    readOnly: false,
    expects: ["config", "secrets"],
    blurb: "just the gate — resolve secrets + secret-scan hook, nothing else",
  },
};

export const MODE_NAMES = Object.keys(MODES) as SetupMode[];

/** Flag wins over config wins over the `full` default. Returns the profile plus
 *  whether the requested name was recognized (so the caller can warn on a typo). */
export function resolveMode(
  flagMode: string | undefined,
  configMode: string | undefined,
): { profile: ModeProfile; requested: string | undefined; recognized: boolean } {
  const requested = (flagMode ?? configMode)?.trim().toLowerCase() || undefined;
  if (requested && requested in MODES) {
    return { profile: MODES[requested as SetupMode], requested, recognized: true };
  }
  return { profile: MODES.full, requested, recognized: requested === undefined };
}

export interface SubsystemStatus {
  key: SubsystemKey;
  label: string;
  ok: boolean;
  /** next step to close the gap (shown by `kit status`) */
  next?: string;
}

/** Score the subsystems a mode expects: done/total + the gaps still open. */
export function modeScore(
  profile: ModeProfile,
  statuses: SubsystemStatus[],
): { done: number; total: number; gaps: SubsystemStatus[] } {
  const relevant = statuses.filter((s) => profile.expects.includes(s.key));
  const gaps = relevant.filter((s) => !s.ok);
  return { done: relevant.length - gaps.length, total: relevant.length, gaps };
}
