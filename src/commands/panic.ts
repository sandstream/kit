// `kit panic` — one-command compromise response (3.0 control-plane kill-switch).
//
// A lost/stolen device or leaked key is an EMERGENCY: you want one memorable
// command that does what kit CAN own and clearly lists what it can't. kit panic:
//   1. rotates the local identity (new keypair; old archived but kept verifiable);
//   2. emits a SIGNED, propagating revocation of the old key (asymmetric — anyone
//      with a trusted public key can verify it, no shared secret to leak);
//   3. records the event in the tamper-evident audit log (itself signed by the
//      new identity);
//   4. prints the platform-revocation checklist for the accounts kit does NOT
//      own (GitHub / Apple / Anthropic) — kit orchestrates + links, you trigger.
//
// Honest boundary: kit owns its own keys, the revocation list + verification
// against it, and the audit of the revocation. It can NOT log you out of GitHub
// or wipe a phone — those are your platform accounts' own controls. Deterministic,
// zero-LLM, local-first.
import { c } from "../utils/colors.js";
import { flagValue, hasFlag } from "../utils/flags.js";
import { tryLoadIdentity, rotateIdentity } from "../identity.js";
import { keystoreRecordRevocation } from "../keystore/revoke.js";
import { hardwareRequired } from "../keystore/index.js";
import { getCurrentProjectRoot } from "../memory/project.js";
import { appendAuditEventDirect } from "../audit.js";

/** The accounts/controls kit can only orchestrate — never silently "handle". */
const PLATFORM_CHECKLIST: { label: string; action: string; url: string }[] = [
  {
    label: "GitHub",
    action: "Revoke active sessions + tokens, review SSH/GPG keys",
    url: "https://github.com/settings/security",
  },
  {
    label: "Anthropic / Claude",
    action: "Log out all devices + rotate API keys",
    url: "https://console.anthropic.com/settings/keys",
  },
  {
    label: "Apple / device",
    action: "Mark the device lost + remote-wipe (Find My)",
    url: "https://www.icloud.com/find",
  },
  {
    label: "Vault / secrets",
    action: "Rotate any secrets the device could read (kit secrets rotate per provider)",
    url: "",
  },
];

export async function cmdPanic(): Promise<boolean> {
  const reason = flagValue(process.argv, "--reason") ?? "panic: device/key compromise";
  const skipChecklist = hasFlag(process.argv, "--no-checklist");

  const current = tryLoadIdentity();
  if (!current) {
    console.error(
      `${c.red}no identity to rotate${c.reset} — there is nothing to revoke. ` +
        `Run ${c.bold}kit identity init${c.reset} first if you want a signing identity.`,
    );
    return false;
  }

  // Under a hardware mandate (env OR org policy), refuse to rotate INTO a file key — panic
  // reaches rotateIdentity() directly, whose own guard is env-only, so without this a
  // policy-only mandate would let panic re-mint exactly the same-UID file key the mandate
  // forbids. Provision/rotate the hardware key out of band instead.
  if (hardwareRequired(getCurrentProjectRoot())) {
    console.error(
      `${c.red}✗ hardware/externally-held identity required${c.reset} ${c.dim}(env or .kit-policy require_hardware_identity)${c.reset} — ` +
        `rotate the key in your TPM/HSM/enclave and update KIT_KEYSTORE_PUBKEY; kit won't mint a file key here.`,
    );
    return false;
  }

  // 1) Rotate — the old key is archived (its past signatures stay verifiable),
  //    a fresh keypair becomes current.
  const { identity: fresh, previousId } = rotateIdentity();

  // 2) Signed revocation of the old key, signed BY the new (now-current) one — via the
  //    active keystore, so a hardware backend signs+attributes it (and a mandate is
  //    honored) instead of always using the file key.
  let revoked = false;
  if (previousId) {
    try {
      keystoreRecordRevocation(previousId, reason);
      revoked = true;
    } catch (err) {
      console.error(
        `${c.yellow}!${c.reset} could not record revocation: ${(err as Error).message}`,
      );
    }
  }

  // 3) Tamper-evident audit trail (this line is itself signed by the new identity).
  await appendAuditEventDirect({
    operation: "identity.panic",
    environment: "local",
    success: true,
    metadata: { revoked_kid: previousId, new_kid: fresh.id, reason },
  });

  // Report.
  console.log(`${c.red}${c.bold}⚠ kit panic — compromise response${c.reset}`);
  console.log(`${c.green}✓${c.reset} rotated identity → ${c.bold}${fresh.id}${c.reset}`);
  if (previousId) {
    const tag = revoked
      ? `${c.green}revoked${c.reset}`
      : `${c.yellow}archived (revoke failed)${c.reset}`;
    console.log(
      `  ${c.dim}old identity ${previousId} → ${tag}; its past signatures stay verifiable, new trust is the new key${c.reset}`,
    );
  }
  console.log(
    `  ${c.dim}revocation is signed + append-only (~/.kit/${"revocations.jsonl"}); distribute the new public key (kit identity show --public) to verifiers${c.reset}`,
  );

  if (!skipChecklist) {
    console.log(`\n${c.bold}Now do what kit can't (your platform accounts):${c.reset}`);
    for (const item of PLATFORM_CHECKLIST) {
      const link = item.url ? `  ${c.dim}${item.url}${c.reset}` : "";
      console.log(`  ${c.bold}[ ]${c.reset} ${item.label}: ${item.action}${link}`);
    }
    console.log(
      `\n${c.dim}kit owns: its identities/keys, the signed revocation list + verification, and this audit record. ` +
        `It only orchestrates the account revocations above — trigger them yourself.${c.reset}`,
    );
  }

  // Recovery hint — durable state was never trapped on the device.
  console.log(
    `\n${c.dim}Recover on a clean device: clone the repo + ${c.reset}${c.bold}kit memory restore${c.reset}${c.dim} (encrypted backup) + ${c.reset}${c.bold}kit identity init${c.reset}${c.dim} — state lives off-device, not on the lost one.${c.reset}`,
  );
  return true;
}
