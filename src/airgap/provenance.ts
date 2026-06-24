/**
 * Offline SLSA/Sigstore provenance verification for an air-gapped enclave.
 *
 * kit does NOT reimplement Sigstore verification — it orchestrates **cosign**,
 * the correct verifier, in fully OFFLINE mode:
 *
 *   cosign verify-blob --offline \
 *     --trusted-root <shipped-in trusted_root.json> \
 *     --bundle <artifact.bundle> \
 *     --certificate-identity <id> --certificate-oidc-issuer <iss> \
 *     <artifact>
 *
 * `--offline` skips the Rekor network lookup (uses the bundle's inclusion
 * proof); `--trusted-root` supplies the Fulcio/Rekor/CT trust roots that the
 * operator distributes into the enclave (no Fulcio/Rekor egress). Everything is
 * FAIL-CLOSED: a missing cosign, missing trust root, missing identity
 * constraints, or a non-zero exit all mean NOT VERIFIED — kit never reports
 * "verified" unless cosign returned success.
 */

export interface ProvenanceVerifyOptions {
  /** Path to the artifact whose provenance is being checked. */
  artifact: string;
  /** Path to the Sigstore bundle (.sigstore/.bundle) for the artifact. */
  bundle: string;
  /** Path to a shipped-in Sigstore trusted_root.json (the offline trust anchor). */
  trustedRoot: string;
  /** Required identity constraint — the SAN cosign must match (e.g. a repo URI). */
  certIdentity: string;
  /** Required OIDC issuer constraint (e.g. https://token.actions.githubusercontent.com). */
  certIssuer: string;
}

/** Fields that must all be present, or verification is refused (fail-closed). */
const REQUIRED: (keyof ProvenanceVerifyOptions)[] = [
  "artifact",
  "bundle",
  "trustedRoot",
  "certIdentity",
  "certIssuer",
];

/** Returns the first missing/empty required field, or null when all present. */
export function missingField(opts: Partial<ProvenanceVerifyOptions>): string | null {
  for (const k of REQUIRED) {
    const v = opts[k];
    if (typeof v !== "string" || v.trim() === "") return k;
  }
  return null;
}

/** Build the cosign argv for offline blob verification. Pure (assumes validated opts). */
export function buildCosignArgs(opts: ProvenanceVerifyOptions): string[] {
  return [
    "verify-blob",
    "--offline",
    "--trusted-root",
    opts.trustedRoot,
    "--bundle",
    opts.bundle,
    "--certificate-identity",
    opts.certIdentity,
    "--certificate-oidc-issuer",
    opts.certIssuer,
    opts.artifact,
  ];
}

export interface ProvenanceDeps {
  /** Resolve the cosign binary, or null if not installed. */
  resolveBin: (bin: string) => Promise<string | null>;
  /** Run a command without throwing; ok=true iff exit 0. */
  run: (bin: string, args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
}

export type ProvenanceResult = { ok: true } | { ok: false; reason: string };

/**
 * Verify provenance offline via cosign. Fail-closed: any missing input,
 * missing cosign, or non-zero cosign exit → `{ ok: false }`. Only a clean
 * cosign success returns `{ ok: true }`.
 */
export async function verifyProvenance(
  opts: Partial<ProvenanceVerifyOptions>,
  deps: ProvenanceDeps,
): Promise<ProvenanceResult> {
  const missing = missingField(opts);
  if (missing) {
    return { ok: false, reason: `missing ${missing} — cannot verify provenance (fail-closed)` };
  }
  const cosign = await deps.resolveBin("cosign");
  if (!cosign) {
    return { ok: false, reason: "cosign not found — cannot verify provenance (fail-closed)" };
  }
  const args = buildCosignArgs(opts as ProvenanceVerifyOptions);
  const res = await deps.run(cosign, args);
  if (!res.ok) {
    const detail =
      (res.stderr || res.stdout || "").trim().split("\n").pop() ?? "verification failed";
    return { ok: false, reason: `cosign rejected the bundle: ${detail}` };
  }
  return { ok: true };
}
