/**
 * `kit login` command — extracted from cli.ts (5.0-alpha god-module split).
 * cmdLogin authenticates configured service CLIs (vault/interactive/capture),
 * with a --plan preview and retry loop. ensureSecretsBackend (1Password signin
 * preflight) is login-only, kept module-private. cmdSetup (still in cli.ts)
 * calls the exported cmdLogin. Imports only sibling core modules.
 */
import { spawn as spawnChild } from "node:child_process";
import { c } from "../utils/colors.js";
import { hasFlag, flagValue } from "../utils/flags.js";
import { loadConfig, type kitConfig } from "../config.js";
import { KIT_FILE, resolveConfigPath } from "../cli-shared.js";
import { check1PasswordStatus, detect1PasswordMode } from "../onepassword.js";
import { isNonInteractive } from "../environment.js";
import { withGovernance } from "../governance-middleware.js";
import { loginServices } from "../login.js";
import { resolveAllAuth } from "../service-auth.js";

async function ensureSecretsBackend(config: kitConfig): Promise<boolean> {
  // Some secret backends (1Password) need a separate interactive signin before
  // any of the per-key `op read` calls can succeed. Run it once up front so
  // `kit setup` produces a usable .env.local in a single pass.
  if (config.secrets?.store !== "1password") return true;

  const { mode, hint } = await detect1PasswordMode();

  // Already authenticated via the desktop app or a service-account token —
  // nothing else to do, the per-key `op read` calls will inherit auth.
  if (mode === "service-account" || mode === "desktop-integration") {
    return true;
  }

  if (mode === "not-installed") {
    console.log(`${c.yellow}1Password CLI not installed.${c.reset}`);
    console.log(`${c.dim}${hint}${c.reset}\n`);
    return false;
  }

  if (mode === "no-account") {
    console.log(`${c.yellow}No 1Password account configured.${c.reset}`);
    console.log(`${c.dim}${hint}${c.reset}\n`);
    return false;
  }

  // mode === "eval-signin": op exists, accounts exist, but no live session.
  // We can't propagate OP_SESSION_<shorthand> from a child spawn back into
  // the parent shell, so attempting `op signin` here would print eval-able
  // text but leave the running kit invocation without auth. Explain the
  // two viable paths to the user instead.

  if (isNonInteractive()) {
    console.log(
      `${c.yellow}1Password not signed in — non-interactive mode can't recover.${c.reset}`,
    );
    console.log(`${c.dim}${hint}${c.reset}\n`);
    return false;
  }

  console.log(`${c.yellow}1Password not signed in.${c.reset}`);
  console.log(`${c.dim}${hint}${c.reset}`);
  console.log(
    `${c.dim}For headless / CI: set ${c.bold}OP_SERVICE_ACCOUNT_TOKEN${c.reset}${c.dim} instead.${c.reset}\n`,
  );

  // Last resort — try `op signin` interactively. With desktop-integration
  // enabled mid-session this will succeed; with eval-only setups it will
  // print export commands the user can copy.
  const ok = await new Promise<boolean>((resolve) => {
    const child = spawnChild("op", ["signin"], {
      stdio: "inherit",
      env: { ...process.env },
    });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });

  if (!ok) return false;

  const verify = await check1PasswordStatus();
  if (!verify.authenticated) {
    console.log(`${c.yellow}Still not authenticated — see hint above.${c.reset}\n`);
    return false;
  }
  console.log(`${c.green}✓ 1Password authenticated${c.reset}\n`);
  return true;
}

export async function cmdLogin(): Promise<boolean> {
  const config = await loadConfig(resolveConfigPath());

  // Per-service control: `--service <name>` narrows the login to a single
  // configured service. Useful when one auth flakes and you don't want to
  // re-run all 8 services again. `--retry-count N` retries the same login
  // command on failure with exponential backoff. `--force-reauth` is
  // accepted but currently a no-op flag the CLI layer surfaces — the
  // underlying service-adapter is responsible for honoring it (most just
  // re-run their login command idempotently anyway).
  const args = process.argv.slice(3);
  const serviceFilter = flagValue(args, "--service");
  const retryIdx = args.indexOf("--retry-count");
  const retryCount =
    retryIdx >= 0 && args[retryIdx + 1] ? Math.max(0, parseInt(args[retryIdx + 1]!, 10) || 0) : 0;

  const backendOk = await ensureSecretsBackend(config);

  if (!config.services || Object.keys(config.services).length === 0) {
    console.log(`${c.dim}No services configured in ${KIT_FILE}${c.reset}`);
    return backendOk;
  }

  // Narrow services config to the requested one, if any.
  let servicesConfig = config.services;
  if (serviceFilter) {
    if (!servicesConfig[serviceFilter]) {
      console.error(
        `${c.red}No service "${serviceFilter}" in .kit.toml. Available: ${Object.keys(servicesConfig).join(", ")}${c.reset}`,
      );
      return false;
    }
    servicesConfig = { [serviceFilter]: servicesConfig[serviceFilter]! };
    console.log(
      `${c.dim}Filtering to service "${serviceFilter}"${retryCount ? ` (retries=${retryCount})` : ""}${c.reset}`,
    );
  }

  // `--plan`: read-only. Show the resolved auth strategy per service (vault /
  // interactive / capture, + passkey warnings) without logging in to anything.
  if (hasFlag(args, "--plan")) {
    const plan = resolveAllAuth(servicesConfig);
    if (hasFlag(args, "--json")) {
      console.log(JSON.stringify(plan, null, 2));
      return true;
    }
    console.log(`${c.bold}auth plan${c.reset}  ${c.dim}${plan.length} service(s)${c.reset}`);
    for (const p of plan) {
      const tag = p.passkey
        ? `${c.yellow}${p.strategy} ⚿${c.reset}`
        : `${c.cyan}${p.strategy}${c.reset}`;
      console.log(`  ${tag}  ${p.name}  ${c.dim}${p.instruction}${c.reset}`);
    }
    return true;
  }

  console.log(`${c.bold}${c.cyan}Authenticating services...${c.reset}`);

  return await withGovernance(
    config,
    {
      operation: "services.login",
      operationType: "write",
      metadata: {
        services: Object.keys(servicesConfig),
      },
    },
    async () => {
      let results = await loginServices(servicesConfig);
      // Retry-loop: re-run failing services up to retryCount times with
      // exponential backoff (250ms, 500ms, 1s, ...). Each attempt only
      // re-tries services that were marked failed/login_unverified.
      for (let attempt = 1; attempt <= retryCount; attempt++) {
        const failed = results.filter(
          (r) => r.action === "failed" || r.action === "login_unverified",
        );
        if (failed.length === 0) break;
        const backoffMs = 250 * 2 ** (attempt - 1);
        console.log(
          `${c.dim}Retrying ${failed.length} service(s) in ${backoffMs}ms (attempt ${attempt}/${retryCount})...${c.reset}`,
        );
        await new Promise((res) => setTimeout(res, backoffMs));
        const retryConfig: typeof servicesConfig = {};
        for (const f of failed) {
          if (servicesConfig[f.name]) retryConfig[f.name] = servicesConfig[f.name]!;
        }
        const retryResults = await loginServices(retryConfig);
        // Merge: replace failed entries with their retry outcome.
        const updated = new Map(results.map((r) => [r.name, r]));
        for (const r of retryResults) updated.set(r.name, r);
        results = Array.from(updated.values());
      }
      let allOk = true;

      console.log();
      for (const r of results) {
        const icon =
          r.action === "failed"
            ? `${c.red}✗${c.reset}`
            : r.action === "login_unverified"
              ? `${c.yellow}?${c.reset}`
              : r.action === "manual"
                ? `${c.yellow}!${c.reset}`
                : `${c.green}✓${c.reset}`;
        const label =
          r.action === "already_authenticated"
            ? `${c.dim}already authenticated${c.reset}`
            : r.action === "logged_in"
              ? `${c.green}logged in${c.reset}`
              : r.action === "login_unverified"
                ? `${c.yellow}login unverified${c.reset}`
                : r.action === "manual"
                  ? `${c.yellow}manual${c.reset}`
                  : `${c.red}failed${c.reset}`;
        console.log(`  ${icon} ${r.name}  ${label}  ${c.dim}${r.detail}${c.reset}`);
        if (r.action === "failed" || r.action === "login_unverified") allOk = false;
      }

      console.log();
      return allOk && backendOk;
    },
  );
}
