/**
 * The hardware-identity mandate flag, in its own ZERO-IMPORT module.
 *
 * It lives here (not in active.ts) so the low-level file signer in identity.ts can import
 * it to fail closed WITHOUT creating an import cycle (identity.ts → active.ts → resolve.ts
 * → file-store.ts → identity.ts). Reading an env var needs no other code.
 */

/** True when the environment mandates a hardware/externally-held identity for signing. */
export function hardwareRequiredByEnv(): boolean {
  const v = (process.env.KIT_REQUIRE_HARDWARE_IDENTITY ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}
