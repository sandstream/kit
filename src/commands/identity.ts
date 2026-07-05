// `kit identity` — manage this machine/agent's cryptographic identity (3.0 Phase 0).
import { c } from "../utils/colors.js";
import { hasFlag } from "../utils/flags.js";
import { loadOrCreateIdentity, tryLoadIdentity, rotateIdentity, identityId } from "../identity.js";
import { activeKeyStoreStatus, hardwareRequiredByEnv } from "../keystore/index.js";

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
  console.log(`  key id         ${st.kid ?? c.dim + "none" + c.reset}`);
  console.log(
    `  hardware req'd  ${hardwareRequiredByEnv() ? "yes (KIT_REQUIRE_HARDWARE_IDENTITY)" : "no"}`,
  );
  if (st.hardwareRooted) {
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
  // Fail closed in the exit code when hardware is mandated but not in force.
  if (hardwareRequiredByEnv() && !st.hardwareRooted) {
    console.error(`${c.red}✗ hardware-rooted identity required but not active${c.reset}`);
    return false;
  }
  return true;
}

export async function cmdIdentity(): Promise<boolean> {
  const sub = process.argv[3] ?? "show";

  if (sub === "keystore") return identityKeystore();

  if (sub === "init") {
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
    console.log(`  id        ${id.id}`);
    console.log(`  algo      ${id.algo}`);
    console.log(`  created   ${id.createdAt}`);
    console.log(`  publicKey ${c.dim}SPKI PEM (kit identity show --public to export)${c.reset}`);
    // Self-check: the record's id must match its public key (catches a tampered record).
    if (identityId(id.publicKey) !== id.id) {
      console.log(
        `  ${c.yellow}!${c.reset} ${c.dim}id does not match the public key — record may be corrupt; re-run kit identity rotate${c.reset}`,
      );
    }
    return true;
  }

  if (sub === "rotate") {
    const { identity, previousId } = rotateIdentity();
    console.log(`${c.green}✓${c.reset} rotated identity → ${c.bold}${identity.id}${c.reset}`);
    if (previousId) {
      console.log(
        `  ${c.yellow}!${c.reset} ${c.dim}previous identity ${previousId} archived (.bak); artifacts it signed stay verifiable with the archived public key, but new signatures use the new id${c.reset}`,
      );
    }
    return true;
  }

  console.error(`${c.red}usage: kit identity <init|show [--public]|rotate|keystore>${c.reset}`);
  return false;
}
