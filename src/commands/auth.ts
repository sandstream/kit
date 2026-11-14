// Auth commands for TOTP enrollment and project approval.
import {
  grantElevation,
  clearElevation,
  readElevation,
  elevationIsActive,
  elevationTtlMinutes,
  verifyTotp,
  enrollTotp,
  resolveTotpSecret,
  TotpSecretUnusableError,
} from "../elevation.js";
import { isNonInteractive } from "../environment.js";
import { promptConfirm } from "../utils/prompt.js";
import { c } from "../utils/colors.js";
import { hasFlag, flagValue } from "../utils/flags.js";
import { authArgumentError } from "../auth-arguments.js";
import { sanitizeDisplayText } from "../display-text.js";

export async function cmdAuth(): Promise<boolean> {
  const invalid = authArgumentError(process.argv.slice(2));
  if (invalid) {
    console.error(invalid);
    return false;
  }
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
  const overwrite = hasFlag(args, "--overwrite");

  const issuer = flagValue(args, "--issuer") ?? "kit";
  const defaultAccount = `${process.env.USER ?? "user"}@${process.env.HOSTNAME ?? "host"}`;
  const accountName = flagValue(args, "--account") ?? defaultAccount;

  console.log(`${c.bold}${c.cyan}kit auth setup-totp${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  let result;
  try {
    result = await enrollTotp({ accountName, issuer, overwrite });
  } catch (err: unknown) {
    const msg = sanitizeDisplayText(err instanceof Error ? err.message : String(err));
    console.error(`${c.red}✗ ${msg}${c.reset}`);
    const recovery =
      err instanceof Error && "code" in err && err.code === "EISDIR"
        ? "Move the directory aside and keep its contents. Then run `kit auth setup-totp` to enroll a new secret."
        : "If the path is a directory, move the directory aside and keep its contents. " +
          "Then run `kit auth setup-totp`. To replace a file or symlink, run `kit auth setup-totp --overwrite`.";
    console.error(
      `${c.dim}${recovery} Your old authenticator entry will stop working.${c.reset}\n`,
    );
    return false;
  }

  console.log(
    `  ${c.green}✓${c.reset} secret written to ${sanitizeDisplayText(result.filePath)}  ${c.dim}(chmod 600)${c.reset}\n`,
  );
  console.log(`${c.bold}Provisioning URI:${c.reset}`);
  console.log(`  ${c.dim}${result.uri}${c.reset}\n`);
  console.log(`${c.bold}Or enter the secret manually in your authenticator app:${c.reset}`);
  console.log(`  ${c.bold}Secret:${c.reset}  ${result.secret}`);
  console.log(`  ${c.bold}Account:${c.reset} ${sanitizeDisplayText(accountName)}`);
  console.log(`  ${c.bold}Issuer:${c.reset}  ${sanitizeDisplayText(issuer)}\n`);
  console.log(`${c.bold}Verify enrollment. The current 6-digit code is:${c.reset}`);
  console.log(
    `  ${c.bold}${result.currentCode}${c.reset}  ${c.dim}(or the one shown in your authenticator right now)${c.reset}\n`,
  );
  console.log(
    `${c.dim}Future ${c.bold}kit auth elevate${c.reset}${c.dim} runs will prompt for the TOTP code automatically.${c.reset}`,
  );
  console.log(
    `${c.dim}KIT_TOTP_SECRET can supply an external secret. Elevation still requires an interactive terminal.${c.reset}\n`,
  );
  return true;
}

async function printScopes(jsonMode: boolean): Promise<void> {
  const { listScopes } = await import("../elevation-scopes.js");
  const scopes = listScopes();
  if (jsonMode) {
    console.log(JSON.stringify(scopes, null, 2));
    return;
  }
  console.log(`${c.bold}${c.cyan}kit auth elevate: scopes${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}`);
  for (const s of scopes) {
    const oneShot = s.oneShot
      ? `${c.yellow}one-shot${c.reset} ${c.dim}(consumed by a single op)${c.reset}`
      : `${c.dim}reusable for the TTL${c.reset}`;
    console.log(`  ${c.bold}${s.scope}${c.reset}  ${c.dim}← ${s.key}${c.reset}`);
    // The description is the whole point of asking: it says what the scope lets through
    // ("invalidates anon + service_role + all sessions"). Listing scope names alone would
    // make the operator guess exactly where guessing is most expensive.
    console.log(`      ${c.dim}${s.description}${c.reset}`);
    console.log(`      ${oneShot}`);
  }
  console.log(
    `\n${c.dim}Elevate with ${c.bold}kit auth elevate --scope <scope>${c.reset}${c.dim}; omitting --scope grants ${c.bold}all${c.reset}${c.dim}.${c.reset}`,
  );
}

/** Ask for one TOTP code. A wrong code, a timeout and closed input all refuse. */
async function confirmTotp(totpSecret: string): Promise<boolean> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const code = (
      await rl.question(`Enter 6-digit TOTP from your authenticator: `, {
        signal: AbortSignal.timeout(15_000),
      })
    ).trim();
    if (!verifyTotp(code, totpSecret)) {
      console.error(`${c.red}✗ Invalid TOTP code.${c.reset}`);
      return false;
    }
    return true;
  } catch {
    console.error("Authentication input was not received. Elevation refused.");
    return false;
  } finally {
    rl.close();
  }
}

/** Grant with the requested lifetime, then restore the process environment. */
async function grantWithTtl(
  scope: string,
  method: "yes-prompt" | "totp",
  ttl: string | undefined,
): ReturnType<typeof grantElevation> {
  const previousTtl = process.env.KIT_ELEVATION_TTL_MINUTES;
  try {
    if (ttl !== undefined) process.env.KIT_ELEVATION_TTL_MINUTES = ttl;
    return await grantElevation(scope, method);
  } finally {
    if (previousTtl === undefined) delete process.env.KIT_ELEVATION_TTL_MINUTES;
    else process.env.KIT_ELEVATION_TTL_MINUTES = previousTtl;
  }
}

async function cmdAuthElevate(): Promise<boolean> {
  const args = process.argv.slice(4);

  // `--list-scopes` must be handled BEFORE anything else. It used to be discarded entirely, and
  // on a TTY that was worse than a no-op: the flag vanished and the command fell through to an
  // interactive elevation prompt for scope=all, the broadest scope. Someone who typed
  // it to ASK WHAT SCOPES EXIST was one keypress from granting themselves everything.
  if (hasFlag(args, "--list-scopes")) {
    await printScopes(hasFlag(args, "--json"));
    return true;
  }

  const scope = flagValue(args, "--scope") ?? "all";
  const ttl = flagValue(args, "--ttl-minutes");
  if (ttl === undefined) elevationTtlMinutes();

  console.log(
    `${c.bold}${c.cyan}kit auth elevate${c.reset}  ${c.dim}(scope=${sanitizeDisplayText(scope)})${c.reset}`,
  );
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  if (isNonInteractive() || !process.stdin.isTTY) {
    console.error(
      `${c.red}✗ Elevation requires an interactive TTY. Cannot run from agent / CI.${c.reset}`,
    );
    console.error(
      `${c.dim}Ask a person to run ${c.bold}kit auth elevate${c.reset}${c.dim} in their own terminal.${c.reset}\n`,
    );
    return false;
  }

  // Resolve from env first, then ~/.kit/totp-secret (created by
  // `kit auth setup-totp`).
  let totpSecret: string | undefined;
  try {
    totpSecret = await resolveTotpSecret();
  } catch (error) {
    if (!(error instanceof TotpSecretUnusableError)) throw error;
    console.error(`${c.red}✗ ${sanitizeDisplayText(error.message)}${c.reset}\n`);
    return false;
  }
  let method: "yes-prompt" | "totp" = "yes-prompt";

  if (totpSecret) {
    method = "totp";
    if (!(await confirmTotp(totpSecret))) return false;
  } else {
    const ok = await promptConfirm(
      `Confirm elevation [y/N, default no in 15s]: `,
      15_000,
      false, // fail closed: walk-away / piped must NOT grant elevation
    );
    if (!ok) {
      console.log(`${c.dim}Aborted.${c.reset}`);
      return false;
    }
  }

  const state = await grantWithTtl(scope, method, ttl);
  console.log(
    `  ${c.green}✓${c.reset} elevated  ${c.dim}scope=${sanitizeDisplayText(state.scope)}  method=${state.method}  expires=${state.expiresAt}${c.reset}`,
  );
  console.log(
    `\n${c.dim}Run ${c.bold}kit auth revoke${c.reset}${c.dim} to remove this project approval before it expires.${c.reset}\n`,
  );
  return true;
}

async function cmdAuthStatus(): Promise<boolean> {
  const state = await readElevation(process.cwd());
  if (hasFlag(process.argv, "--json")) {
    console.log(
      JSON.stringify(
        {
          active: state !== null && elevationIsActive(state),
          state: state
            ? {
                ...state,
                scope: sanitizeDisplayText(state.scope),
                granter: sanitizeDisplayText(state.granter),
              }
            : null,
        },
        null,
        2,
      ),
    );
    return true;
  }
  if (!state) {
    console.log(`${c.dim}Not elevated.${c.reset}`);
    return true;
  }
  // The shared predicate, not a second copy: this line used to compute validity as
  // `expires > now` while the gate used `expires < now` for expiry, so at the exact
  // expiry millisecond the gate granted and this command printed "expired".
  const valid = elevationIsActive(state);
  const status = valid
    ? `${c.green}active${c.reset}  ${c.dim}(expires ${state.expiresAt})${c.reset}`
    : `${c.red}expired${c.reset}  ${c.dim}(at ${state.expiresAt})${c.reset}`;
  console.log(
    `${status}  scope=${sanitizeDisplayText(state.scope)}  method=${state.method}  granter=${sanitizeDisplayText(state.granter)}`,
  );
  return true;
}

async function cmdAuthRevoke(): Promise<boolean> {
  try {
    await clearElevation(process.cwd());
  } catch {
    console.error("Could not clear the elevation marker. Access may remain active.");
    return false;
  }
  console.log(`${c.green}✓${c.reset} elevation marker cleared.`);
  return true;
}
