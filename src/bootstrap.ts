/**
 * `kit bootstrap` — pure planning + receipt core for cold-starting an ephemeral
 * environment.
 *
 * This module is the DECISION half: given the seed the platform injected (env vars
 * + flags) it produces the ordered step plan and the fail-mode of each step, and it
 * turns executed step results into a receipt + overall verdict. It is pure and
 * deterministic — no I/O, no spawning — so the whole contract (which steps run, what
 * skips, what is fatal vs degraded) is unit-tested. The command (`commands/bootstrap`)
 * is the thin executor that spawns each step's kit subcommand and hands the results
 * back here.
 *
 * Fail matrix (the safety story): the FLOOR is fail-closed — config, identity, and
 * the INTEGRITY of policy/profile must never ship broken. The FUEL is fail-open —
 * secrets availability and recall degrade to a blank-but-working environment rather
 * than failing the whole bootstrap. A profile bundle grants integrity, never trust.
 */

export type StepId = "config" | "identity" | "policy" | "profile" | "recall";
export type FailMode = "fail-closed" | "fail-open";

/** What the platform's secret store injected + the operator's flags. */
export interface BootstrapSeed {
  /** A profile bundle path was provided (`--profile <path>`). */
  profileBundle?: string;
  /** `$KIT_MEMORY_BACKUP` points at an encrypted backup to restore. */
  memoryBackup?: string;
  /** A control plane is configured (signers anchored) so `kit policy pull` is meaningful. */
  controlPlane: boolean;
}

export interface BootstrapOpts {
  /** `--minimal` runs `kit setup --minimal`; default is `--recommended`. */
  minimal?: boolean;
  /** `--no-memory` skips recall even when a backup is present. */
  noMemory?: boolean;
}

export interface BootstrapStep {
  id: StepId;
  /** Argv for the kit subcommand to spawn, or null when the step is skipped. */
  argv: string[] | null;
  failMode: FailMode;
  /** Present iff the step is skipped (absent seed / precondition). */
  skippedReason?: string;
}

/**
 * Plan the ordered bootstrap steps from the seed. Order is fixed — each step assumes
 * the previous. Config + identity always run (fail-closed floor). Policy runs only
 * with a control plane; profile only with a bundle; recall only with a backup and
 * unless `--no-memory` — each fail-open or skipped when its seed is absent.
 * Secrets are NOT a step: `kit setup` resolves them lazily from the vault at use time.
 */
export function planBootstrap(seed: BootstrapSeed, opts: BootstrapOpts = {}): BootstrapStep[] {
  const steps: BootstrapStep[] = [];

  steps.push({
    id: "config",
    argv: ["setup", opts.minimal ? "--minimal" : "--recommended"],
    failMode: "fail-closed",
  });

  steps.push({ id: "identity", argv: ["identity", "init"], failMode: "fail-closed" });

  steps.push(
    seed.controlPlane
      ? { id: "policy", argv: ["policy", "pull"], failMode: "fail-closed" }
      : {
          id: "policy",
          argv: null,
          failMode: "fail-closed",
          skippedReason: "no control plane configured",
        },
  );

  steps.push(
    seed.profileBundle
      ? { id: "profile", argv: ["profile", "import", seed.profileBundle], failMode: "fail-closed" }
      : {
          id: "profile",
          argv: null,
          failMode: "fail-closed",
          skippedReason: "no profile bundle provided",
        },
  );

  if (opts.noMemory) {
    steps.push({ id: "recall", argv: null, failMode: "fail-open", skippedReason: "--no-memory" });
  } else if (seed.memoryBackup) {
    steps.push({
      id: "recall",
      argv: ["memory", "restore", seed.memoryBackup],
      failMode: "fail-open",
    });
  } else {
    steps.push({
      id: "recall",
      argv: null,
      failMode: "fail-open",
      skippedReason: "no $KIT_MEMORY_BACKUP",
    });
  }

  return steps;
}

export type StepStatus = "ok" | "skipped" | "degraded" | "failed";

export interface StepResult {
  id: StepId;
  status: StepStatus;
  failMode: FailMode;
  detail: string;
}

/**
 * Classify one executed step. `ran` is the subcommand's success (exit 0). A skipped
 * step (argv null) is reported as `skipped`. A failure is `failed` for a fail-closed
 * step (fatal) and `degraded` for a fail-open step (the environment still works).
 * Pure.
 */
export function classifyStep(step: BootstrapStep, ran: boolean | null): StepResult {
  if (step.argv === null) {
    return {
      id: step.id,
      status: "skipped",
      failMode: step.failMode,
      detail: step.skippedReason ?? "skipped",
    };
  }
  if (ran) return { id: step.id, status: "ok", failMode: step.failMode, detail: "ok" };
  return step.failMode === "fail-closed"
    ? {
        id: step.id,
        status: "failed",
        failMode: step.failMode,
        detail: "failed (fail-closed — bootstrap aborted)",
      }
    : {
        id: step.id,
        status: "degraded",
        failMode: step.failMode,
        detail: "failed (fail-open — continued, environment degraded)",
      };
}

export interface BootstrapReceipt {
  steps: StepResult[];
  /** True unless a fail-closed step failed. A degraded fail-open step keeps ok=true. */
  ok: boolean;
  /** True when any fail-open step degraded (worth surfacing, not fatal). */
  degraded: boolean;
}

/** Fold step results into the overall verdict. ok=false iff a fail-closed step failed. */
export function summarize(steps: StepResult[]): BootstrapReceipt {
  return {
    steps,
    ok: !steps.some((s) => s.status === "failed"),
    degraded: steps.some((s) => s.status === "degraded"),
  };
}

/** True when the plan must stop here: a fail-closed step just failed. Pure. */
export function isFatal(result: StepResult): boolean {
  return result.status === "failed";
}
