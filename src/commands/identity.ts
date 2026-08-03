// `kit identity` — manage this machine/agent's cryptographic identity (3.0 Phase 0).
import { c } from "../utils/colors.js";
import { hasFlag } from "../utils/flags.js";
import {
  loadOrCreateIdentity,
  tryLoadIdentity,
  rotateIdentity,
  identityId,
  isRevoked,
} from "../identity.js";
import {
  activeKeyStoreStatus,
  hardwareRequiredByEnv,
  hardwareRequired,
  policyRequiresHardware,
} from "../keystore/index.js";
import { keystoreRecordRevocation } from "../keystore/revoke.js";
import { hasExternalIdentity } from "../keystore/trust-store.js";

/** `kit identity keystore` — surface the active signing backend, honestly. */
function identityKeystore(): boolean {
  const st = activeKeyStoreStatus();
  // "external (operator-fronted)" — NOT an unqualified "hardware-rooted": kit only knows
  // the key isn't a kit-managed file; it cannot attest the operator's command truly fronts
  // a secure element. Honest labels, no false green.
  const held = st.hardwareRooted
    ? `${c.green}external key — operator-fronted${c.reset}`
    : `${c.yellow}kit-managed file key (same-UID readable)${c.reset}`;
  console.log(`${c.bold}kit identity keystore${c.reset}`);
  console.log(`  backend        ${c.bold}${st.kind}${c.reset}  (${held})`);
  const revoked = st.kid !== null && isRevoked(st.kid);
  console.log(
    `  key id         ${st.kid ?? c.dim + "none" + c.reset}${revoked ? `  ${c.red}REVOKED — cannot sign${c.reset}` : ""}`,
  );
  const byEnv = hardwareRequiredByEnv();
  const byPolicy = policyRequiresHardware(process.cwd());
  const reqLabel = byEnv
    ? "yes (KIT_REQUIRE_HARDWARE_IDENTITY)"
    : byPolicy
      ? "yes (.kit-policy require_hardware_identity)"
      : "no";
  console.log(`  hardware req'd  ${reqLabel}`);
  if (st.hardwareRooted) {
    // Whether the external key is in the LOCAL trust store decides whether kit can verify the
    // artifacts it signs with it (profile scope, policy, audit chain). It is recorded on the
    // first successful signature, so a freshly-configured backend legitimately reads "not yet".
    console.log(
      `  locally trusted  ${
        hasExternalIdentity()
          ? `${c.green}yes${c.reset} ${c.dim}(recorded in the local trust store — kit can verify what it signs)${c.reset}`
          : `${c.yellow}not yet${c.reset} ${c.dim}(recorded on the first signature; until then kit reports its own signatures as "signer unknown")${c.reset}`
      }`,
    );
    console.log(
      `  ${c.dim}note: kit can't attest this command fronts real hardware — that (non-exportable key + touch/PIN) is the operator's responsibility${c.reset}`,
    );
  }
  if (st.reason) console.log(`  ${c.dim}${st.reason}${c.reset}`);
  if (!st.hardwareRooted) {
    console.log(
      `  ${c.dim}to move the key out of a kit-managed file: KIT_KEYSTORE=command with KIT_KEYSTORE_SIGN_CMD + KIT_KEYSTORE_PUBKEY (TPM/HSM/enclave/YubiKey)${c.reset}`,
    );
  }
  // Fail closed in the exit code when hardware is mandated (env OR policy) but not in force.
  if ((byEnv || byPolicy) && !st.hardwareRooted) {
    console.error(`${c.red}✗ hardware-rooted identity required but not active${c.reset}`);
    return false;
  }
  return true;
}

/**
 * `kit identity migrate` — you've provisioned an external/hardware-held key
 * (KIT_KEYSTORE=command → your TPM/HSM/enclave/YubiKey) and made it active; this
 * records a signed revocation of the OLD kit-managed file key, SIGNED BY and
 * ATTRIBUTED TO the new active key, so verifiers learn the file key is
 * superseded. kit never mints hardware keys (they are operator-fronted), so
 * "migration" is revoke-the-old, not a kit-run rotation. Past signatures by the
 * file key stay verifiable via its archived public key; the file key is revoked.
 * Fail-closed: refuses unless a hardware/external backend is actually active.
 */
async function identityMigrate(): Promise<boolean> {
  const st = activeKeyStoreStatus();
  if (!st.hardwareRooted) {
    console.error(
      `${c.red}✗ no external/hardware backend active${c.reset} — set ${c.bold}KIT_KEYSTORE=command${c.reset} ${c.dim}(+ KIT_KEYSTORE_SIGN_CMD + KIT_KEYSTORE_PUBKEY, fronting your TPM/HSM/enclave/YubiKey)${c.reset} first; kit won't "migrate" onto a file key`,
    );
    return false;
  }
  const fileId = tryLoadIdentity();
  if (!fileId) {
    console.log(
      `${c.dim}no kit-managed file key found — nothing to revoke; the active identity is already ${st.kid ?? "external"}.${c.reset}`,
    );
    return true;
  }
  if (st.kid && fileId.id === st.kid) {
    console.error(
      `${c.red}✗ the active key IS the file key${c.reset} — nothing migrated. Point ${c.bold}KIT_KEYSTORE_PUBKEY${c.reset} at a different (hardware-held) key before migrating.`,
    );
    return false;
  }
  const rec = keystoreRecordRevocation(fileId.id, "migrated to hardware-rooted identity");
  console.log(
    `${c.green}✓${c.reset} migrated to ${c.bold}${st.kind}${c.reset} identity ${c.bold}${st.kid}${c.reset}`,
  );
  console.log(
    `  ${c.yellow}!${c.reset} ${c.dim}revoked old file key ${rec.kid} (revocation signed by the active key ${rec.by}); its past signatures stay verifiable, new ones use ${st.kid}${c.reset}`,
  );
  console.log(
    `  ${c.dim}the old private key file under ~/.kit is now revoked — delete it once you've confirmed the hardware key works everywhere.${c.reset}`,
  );
  return true;
}

export async function cmdIdentity(): Promise<boolean> {
  const sub = process.argv[3] ?? "show";

  if (sub === "keystore") return identityKeystore();

  if (sub === "migrate") return await identityMigrate();

  if (sub === "init") {
    // Under a hardware mandate (env OR org policy), refuse to mint a same-UID file key —
    // a clean message rather than the raw guard throw from loadOrCreateIdentity.
    if (hardwareRequired(process.cwd())) {
      console.error(
        `${c.red}✗ hardware/externally-held identity required${c.reset} ${c.dim}(env or .kit-policy require_hardware_identity)${c.reset} — provision the key in your TPM/HSM/enclave and set KIT_KEYSTORE=command; kit won't create a file key`,
      );
      return false;
    }
    const { identity, created } = loadOrCreateIdentity();
    console.log(
      `${c.green}✓${c.reset} identity ${created ? "created" : "already exists"}: ${c.bold}${identity.id}${c.reset}`,
    );
    console.log(`  ${c.dim}algo ${identity.algo} · created ${identity.createdAt}${c.reset}`);
    if (created) {
      console.log(
        `  ${c.dim}private key stored owner-only under ~/.kit; share the public key (kit identity show --public) to let others verify your signatures${c.reset}`,
      );
    }
    return true;
  }

  if (sub === "show") {
    const id = tryLoadIdentity();
    if (!id) {
      console.log(`${c.dim}no identity yet — run ${c.reset}${c.bold}kit identity init${c.reset}`);
      return true;
    }
    // `--public` prints just the SPKI PEM so it can be piped/distributed to verifiers.
    if (hasFlag(process.argv, "--public")) {
      process.stdout.write(id.publicKey.endsWith("\n") ? id.publicKey : id.publicKey + "\n");
      return true;
    }
    console.log(`${c.bold}kit identity${c.reset}`);
    // A revoked key still HAS a record — showing it as if nothing were wrong is how a migrated
    // machine looked healthy while every signature it tried to make was being refused.
    const revoked = isRevoked(id.id);
    console.log(`  id        ${id.id}${revoked ? `  ${c.red}REVOKED${c.reset}` : ""}`);
    console.log(`  algo      ${id.algo}`);
    console.log(`  created   ${id.createdAt}`);
    console.log(`  publicKey ${c.dim}SPKI PEM (kit identity show --public to export)${c.reset}`);
    if (revoked) {
      console.log(
        `  ${c.red}!${c.reset} ${c.dim}this identity is revoked on this machine — kit refuses to sign with it. Activate the successor key (KIT_KEYSTORE=command …) or run 'kit identity rotate'${c.reset}`,
      );
    }
    // Self-check: the record's id must match its public key (catches a tampered record).
    if (identityId(id.publicKey) !== id.id) {
      console.log(
        `  ${c.yellow}!${c.reset} ${c.dim}id does not match the public key — record may be corrupt; re-run kit identity rotate${c.reset}`,
      );
    }
    return true;
  }

  if (sub === "rotate") {
    if (hardwareRequired(process.cwd())) {
      console.error(
        `${c.red}✗ hardware/externally-held identity required${c.reset} ${c.dim}(env or .kit-policy require_hardware_identity)${c.reset} — rotate the key in your TPM/HSM/enclave and update KIT_KEYSTORE_PUBKEY; kit won't mint a file key`,
      );
      return false;
    }
    const { identity, previousId } = rotateIdentity();
    console.log(`${c.green}✓${c.reset} rotated identity → ${c.bold}${identity.id}${c.reset}`);
    if (previousId) {
      console.log(
        `  ${c.yellow}!${c.reset} ${c.dim}previous identity ${previousId} archived (.bak); artifacts it signed stay verifiable with the archived public key, but new signatures use the new id${c.reset}`,
      );
    }
    return true;
  }

  console.error(
    `${c.red}usage: kit identity <init|show [--public]|rotate|keystore|migrate>${c.reset}`,
  );
  return false;
}
