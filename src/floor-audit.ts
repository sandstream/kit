/**
 * An audit event when kit's floor moves: a baseline freeze accepts every current finding as the
 * new normal, so it is a decision, not a cache write.
 *
 * kit-research `rsi-autonomy-levels-and-kits-movable-floor` and
 * `retro-skill-self-evolving-agents-vs-kit`: deleting a secret's history is audited, redefining
 * "passing" was not. Best-effort like the gate-deny audit: a missing `.kit.toml` falls back to
 * default governance, and an audit failure never fails the freeze.
 */
export async function auditFloorFreeze(categories: string[], cwd = process.cwd()): Promise<void> {
  try {
    const { loadConfig } = await import("./config.js");
    const { mergeGovernanceConfigAsync } = await import("./governance.js");
    const { logAuditEvent } = await import("./audit.js");
    const { resolve } = await import("node:path");
    const cfg = await loadConfig(resolve(cwd, ".kit.toml")).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    });
    const gov = await mergeGovernanceConfigAsync(cfg?.governance);
    await logAuditEvent(
      gov,
      {
        operation: "baseline-freeze",
        environment: gov.environment,
        success: true,
        metadata: { phase: "floor-freeze", categories: [...categories].sort() },
      },
      { cwd },
    );
  } catch {
    /* best-effort: the freeze itself already happened and is visible in the diff */
  }
}
