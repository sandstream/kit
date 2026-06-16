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
 *
 * Passkey-awareness: some interactive logins open a browser / require a passkey,
 * so they can't be scripted on a fresh machine — the plan flags that explicitly.
 */
import type { ServiceConfig } from "./config.js";

export type AuthStrategy = "vault" | "capture" | "interactive";

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

function isStrategy(v: unknown): v is AuthStrategy {
  return v === "vault" || v === "capture" || v === "interactive";
}

export function resolveServiceAuth(name: string, config: ServiceConfig): ResolvedAuth {
  const explicit = (config as { auth?: unknown }).auth;
  const strategy: AuthStrategy = isStrategy(explicit)
    ? explicit
    : config.login
      ? "interactive"
      : "vault";

  const passkey = strategy === "interactive" && PASSKEY_SERVICES.has(name.toLowerCase());

  let instruction: string;
  switch (strategy) {
    case "vault":
      instruction = "credential resolved from the configured vault (run `kit secrets`)";
      break;
    case "capture":
      instruction = "paste the token once — kit stores it to the vault (run `kit secrets`)";
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
