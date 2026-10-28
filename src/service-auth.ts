/**
 * kit service auth strategies — how kit obtains each service's credential.
 *
 * Deterministic resolver (no side effects, no model calls). A service declares
 * `auth` in .kit.toml; absent that, it's inferred:
 *
 *   - "vault"       — credential lives in the configured vault; `kit secrets`
 *                     resolves it into the env. No interactive login.
 *   - "interactive" — the tool owns its auth; kit runs its `login` command
 *                     (e.g. `gh auth login`). Default when a login command exists.
 *   - "capture"     — kit prompts for the token once and stores it to the vault
 *                     (capture-to-vault). Execution is intentionally NOT wired
 *                     here yet — this resolver only PLANS; `kit login --plan`
 *                     surfaces it. (The capture UX is a deliberate follow-up.)
 *   - "manual"      A comment-only login value describes a setup task. Kit runs no CLI.
 *
 * Passkey-awareness: some interactive logins open a browser / require a passkey,
 * so they can't be scripted on a fresh machine — the plan flags that explicitly.
 */
import type { ServiceConfig } from "./config.js";
import { parseCommand } from "./utils/parseCommand.js";

export type AuthStrategy = "vault" | "capture" | "interactive" | "manual";

export interface ResolvedAuth {
  name: string;
  strategy: AuthStrategy;
  /** Interactive login likely opens a browser / needs a passkey (can't be scripted). */
  passkey: boolean;
  /** Deterministic next-step description. */
  instruction: string;
}

// Interactive logins that open a browser and may require a passkey / device approval.
const PASSKEY_SERVICES = new Set([
  "github",
  "gh",
  "vercel",
  "supabase",
  "cloudflare",
  "fly",
  "railway",
  "gcloud",
  "aws",
  "azure",
]);

function isStrategy(v: unknown): v is Exclude<AuthStrategy, "manual"> {
  return v === "vault" || v === "capture" || v === "interactive";
}

export function resolveServiceAuth(name: string, config: ServiceConfig): ResolvedAuth {
  const explicit = (config as { auth?: unknown }).auth;
  const parsedLogin = config.login ? parseCommand(config.login) : null;
  const strategy: AuthStrategy = isStrategy(explicit)
    ? explicit
    : parsedLogin?.kind === "informational"
      ? "manual"
      : parsedLogin
        ? "interactive"
        : "vault";

  const passkey = strategy === "interactive" && PASSKEY_SERVICES.has(name.toLowerCase());

  let instruction: string;
  switch (strategy) {
    case "vault":
      instruction = "credential resolved from the configured vault (run `kit secrets`)";
      break;
    case "capture":
      instruction =
        "capture-to-vault: `kit secrets set <KEY> --stdin` (paste once, stored in the vault)";
      break;
    case "manual":
      instruction = `manual setup: ${parsedLogin?.kind === "informational" ? parsedLogin.message : "follow the service instructions"}`;
      break;
    case "interactive":
      instruction = config.login
        ? `interactive login: ${config.login}${passkey ? " — needs a browser/passkey, can't be scripted on a fresh machine" : ""}`
        : "interactive login required (no login command configured)";
      break;
  }

  return { name, strategy, passkey, instruction };
}

/** Resolve every service's auth plan, sorted by name for stable output. */
export function resolveAllAuth(services: Record<string, ServiceConfig>): ResolvedAuth[] {
  return Object.keys(services)
    .sort()
    .map((name) => resolveServiceAuth(name, services[name]!));
}
