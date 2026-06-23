// `kit auth` commands (TOTP enrollment + elevation) — extracted from cli.ts (split step 3).
import {
  grantElevation,
  clearElevation,
  readElevation,
  verifyTotp,
  elevationTtlMinutes,
  enrollTotp,
  resolveTotpSecret,
} from "../elevation.js";
import { isNonInteractive } from "../environment.js";
import { promptConfirm } from "../utils/prompt.js";
import { c } from "../utils/colors.js";
import { hasFlag, flagValue } from "../utils/flags.js";

export async function cmdAuth(): Promise<boolean> {
  const sub = process.argv[3];
  if (sub === "elevate") return cmdAuthElevate();
  if (sub === "status") return cmdAuthStatus();
  if (sub === "revoke") return cmdAuthRevoke();
  if (sub === "setup-totp") return cmdAuthSetupTotp();
  console.error(`${c.red}Usage: kit auth [elevate | status | revoke | setup-totp]${c.reset}`);
  return false;
}

async function cmdAuthSetupTotp(): Promise<boolean> {
  // kit auth setup-totp [--issuer <name>] [--account <user@host>] [--overwrite]
  const args = process.argv.slice(4);
  const issuerIdx = args.indexOf("--issuer");
  const accountIdx = args.indexOf("--account");
  const overwrite = hasFlag(args, "--overwrite");

  const issuer = issuerIdx >= 0 ? args[issuerIdx + 1] : "kit";
  const defaultAccount = `${process.env.USER ?? "user"}@${process.env.HOSTNAME ?? "host"}`;
  const accountName = accountIdx >= 0 ? args[accountIdx + 1] : defaultAccount;

  console.log(`${c.bold}${c.cyan}kit auth setup-totp${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  let result;
  try {
    result = await enrollTotp({ accountName, issuer, overwrite });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${c.red}✗ ${msg}${c.reset}`);
    console.error(
      `${c.dim}If you intentionally want to replace the existing secret, re-run with ${c.bold}--overwrite${c.reset}${c.dim} (your old authenticator entry will stop working).${c.reset}\n`,
    );
    return false;
  }

  console.log(
    `  ${c.green}✓${c.reset} secret written to ${result.filePath}  ${c.dim}(chmod 600)${c.reset}\n`,
  );
  console.log(`${c.bold}Provisioning URI:${c.reset}`);
  console.log(`  ${c.dim}${result.uri}${c.reset}\n`);
  console.log(`${c.bold}Or enter the secret manually in your authenticator app:${c.reset}`);
  console.log(`  ${c.bold}Secret:${c.reset}  ${result.secret}`);
  console.log(`  ${c.bold}Account:${c.reset} ${accountName}`);
  console.log(`  ${c.bold}Issuer:${c.reset}  ${issuer}\n`);
  console.log(`${c.bold}Verify enrollment — the next 6-digit code should be:${c.reset}`);
  console.log(
    `  ${c.bold}${result.currentCode}${c.reset}  ${c.dim}(or the one shown in your authenticator right now)${c.reset}\n`,
  );
  console.log(
    `${c.dim}Future ${c.bold}kit auth elevate${c.reset}${c.dim} runs will prompt for the TOTP code automatically.${c.reset}`,
  );
  console.log(
    `${c.dim}Override with ${c.bold}KIT_TOTP_SECRET=...${c.reset}${c.dim} in CI / scripted contexts.${c.reset}\n`,
  );
  return true;
}

async function cmdAuthElevate(): Promise<boolean> {
  const args = process.argv.slice(4);
  const scope = flagValue(args, "--scope") ?? "all";
  const ttlIdx = args.indexOf("--ttl-minutes");
  if (ttlIdx >= 0 && args[ttlIdx + 1]) {
    const n = parseInt(args[ttlIdx + 1], 10);
    if (Number.isFinite(n) && n > 0 && n <= 240) {
      process.env.KIT_ELEVATION_TTL_MINUTES = String(n);
    }
  }

  console.log(`${c.bold}${c.cyan}kit auth elevate${c.reset}  ${c.dim}(scope=${scope})${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  if (isNonInteractive()) {
    console.error(
      `${c.red}✗ Elevation requires an interactive TTY. Cannot run from agent / CI.${c.reset}`,
    );
    console.error(
      `${c.dim}For CI deploy jobs that legitimately need a destructive op, set ${c.bold}KIT_ELEVATED=1${c.reset}${c.dim} (and audit-log the use).${c.reset}\n`,
    );
    return false;
  }

  // Resolve from env first, then ~/.kit/totp-secret (created by
  // `kit auth setup-totp`).
  const totpSecret = await resolveTotpSecret();
  let method: "yes-prompt" | "totp" = "yes-prompt";

  if (totpSecret) {
    method = "totp";
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const code = (await rl.question(`Enter 6-digit TOTP from your authenticator: `)).trim();
      if (!verifyTotp(code, totpSecret)) {
        console.error(`${c.red}✗ Invalid TOTP code.${c.reset}`);
        return false;
      }
    } finally {
      rl.close();
    }
  } else {
    const ok = await promptConfirm(
      `Confirm elevation [type YES, default no in 15s]: `,
      15_000,
      false, // fail closed: walk-away / piped must NOT grant elevation
    );
    if (!ok) {
      console.log(`${c.dim}Aborted.${c.reset}`);
      return false;
    }
  }

  const state = await grantElevation(scope, method);
  console.log(
    `  ${c.green}✓${c.reset} elevated  ${c.dim}scope=${state.scope}  method=${state.method}  expires=${state.expiresAt}${c.reset}`,
  );
  console.log(
    `\n${c.dim}Destructive secret ops (rotate, migrate, onecli register, propagate) are unlocked for ${elevationTtlMinutes()}m. Run ${c.bold}kit auth revoke${c.reset}${c.dim} to drop early.${c.reset}\n`,
  );
  return true;
}

async function cmdAuthStatus(): Promise<boolean> {
  const state = await readElevation(process.cwd());
  if (!state) {
    console.log(`${c.dim}Not elevated.${c.reset}`);
    return true;
  }
  const expires = Date.parse(state.expiresAt);
  const valid = Number.isFinite(expires) && expires > Date.now();
  const status = valid
    ? `${c.green}active${c.reset}  ${c.dim}(expires ${state.expiresAt})${c.reset}`
    : `${c.red}expired${c.reset}  ${c.dim}(at ${state.expiresAt})${c.reset}`;
  console.log(`${status}  scope=${state.scope}  method=${state.method}  granter=${state.granter}`);
  return true;
}

async function cmdAuthRevoke(): Promise<boolean> {
  await clearElevation(process.cwd());
  console.log(`${c.green}✓${c.reset} elevation marker cleared.`);
  return true;
}
