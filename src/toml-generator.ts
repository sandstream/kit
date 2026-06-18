import type { DetectedStack } from "./stack-detector.js";

/**
 * Service config: login command + check command + secret keys
 */
interface ServiceTemplate {
  login: string;
  check: string;
  secrets: string[];
  tool?: string; // mise tool to add if needed
}

const SERVICE_TEMPLATES: Record<string, ServiceTemplate> = {
  stripe: {
    login: "stripe login",
    check: "stripe config --list",
    secrets: ["STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_WEBHOOK_SECRET"],
    tool: "stripe",
  },
  supabase: {
    login: "supabase login",
    check: "supabase projects list",
    secrets: ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"],
    tool: "supabase",
  },
  vercel: {
    login: "vercel login",
    check: "vercel whoami",
    secrets: [],
    tool: "vercel",
  },
  expo: {
    login: "eas login",
    check: "eas whoami",
    secrets: ["EXPO_TOKEN"],
    tool: "eas-cli",
  },
  resend: {
    login: "# resend — no CLI login; set RESEND_API_KEY in env",
    check: "# resend — check RESEND_API_KEY is set",
    secrets: ["RESEND_API_KEY", "RESEND_FROM_EMAIL"],
  },
  clerk: {
    login: "# clerk — no CLI login; get keys from https://dashboard.clerk.com",
    check: "# clerk — check CLERK_SECRET_KEY is set",
    secrets: ["CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"],
  },
  liveblocks: {
    login: "# liveblocks — no CLI login; get keys from https://liveblocks.io/dashboard",
    check: "# liveblocks — check LIVEBLOCKS_SECRET_KEY is set",
    secrets: ["LIVEBLOCKS_SECRET_KEY", "NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY"],
  },
  trigger: {
    login: "# trigger — no CLI login; get key from https://cloud.trigger.dev",
    check: "# trigger — check TRIGGER_SECRET_KEY is set",
    secrets: ["TRIGGER_SECRET_KEY"],
  },
  inngest: {
    login: "# inngest — no CLI login; get keys from https://app.inngest.com",
    check: "# inngest — check INNGEST_EVENT_KEY is set",
    secrets: ["INNGEST_EVENT_KEY", "INNGEST_SIGNING_KEY"],
  },
  sentry: {
    login: "# sentry — no CLI login; get DSN from https://sentry.io",
    check: "# sentry — check SENTRY_DSN is set",
    secrets: ["SENTRY_DSN", "SENTRY_ORG", "SENTRY_PROJECT", "SENTRY_AUTH_TOKEN"],
  },
  netlify: {
    login: "netlify login",
    check: "netlify status",
    secrets: ["NETLIFY_AUTH_TOKEN", "NETLIFY_SITE_ID"],
    tool: "netlify",
  },
  "cloudflare-pages": {
    login: "wrangler login",
    check: "wrangler whoami",
    secrets: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
    tool: "wrangler",
  },
  typeorm: {
    login: "# typeorm — no CLI login; configure DATABASE_URL",
    check: "# typeorm — check DATABASE_URL is set",
    secrets: ["DATABASE_URL"],
  },
  mongoose: {
    login: "# mongoose — no CLI login; configure MONGODB_URI",
    check: "# mongoose — check MONGODB_URI is set",
    secrets: ["MONGODB_URI"],
  },
};

const FRAMEWORK_SETUP: Record<
  string,
  { install: string; dev?: string; migrate?: string; verify?: string }
> = {
  nextjs: { install: "pnpm install", dev: "pnpm dev", verify: "pnpm build" },
  remix: { install: "pnpm install", dev: "pnpm dev", verify: "pnpm build" },
  astro: { install: "pnpm install", dev: "pnpm dev", verify: "pnpm build" },
  sveltekit: { install: "pnpm install", dev: "pnpm dev", verify: "pnpm build" },
  nestjs: { install: "pnpm install", dev: "pnpm start:dev", verify: "pnpm build" },
  express: { install: "pnpm install", dev: "pnpm dev", verify: "pnpm build" },
  react: { install: "pnpm install", dev: "pnpm dev", verify: "pnpm build" },
  fastapi: { install: "uv sync", dev: "uv run uvicorn main:app --reload", verify: "uv run pytest" },
  django: { install: "uv sync", migrate: "uv run python manage.py migrate", verify: "uv run python manage.py check" },
  flask: { install: "uv sync", dev: "uv run flask run", verify: "uv run pytest" },
  gin: { install: "go mod download", dev: "go run .", verify: "go build ./..." },
  echo: { install: "go mod download", dev: "go run .", verify: "go build ./..." },
  fiber: { install: "go mod download", dev: "go run .", verify: "go build ./..." },
  laravel: { install: "composer install", migrate: "php artisan migrate", verify: "php artisan test" },
  symfony: { install: "composer install", verify: "php bin/console lint:all" },
};

/**
 * Security scanners kit installs by default, keyed by mise tool ref → version.
 * `semgrep` resolves through mise's registry to `pipx:semgrep`; socket has no
 * registry shortname, so it uses the npm backend ref directly. Both are looked
 * up at check time by `resolveToolBin` (mise-first), so they run even though
 * mise shims aren't on kit's PATH.
 */
export const DEFAULT_SECURITY_SCANNERS: Record<string, string> = {
  semgrep: "latest",
  "npm:@socketsecurity/cli": "latest",
};

function lines(...parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join("\n");
}

/** TOML bare keys are [A-Za-z0-9_-]; anything else (e.g. a mise backend ref
 *  like `npm:@socketsecurity/cli`) must be quoted. */
function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : `"${k}"`;
}

function toolsSection(tools: Record<string, string>): string {
  if (Object.keys(tools).length === 0) return "";
  const entries = Object.entries(tools)
    .map(([k, v]) => `${tomlKey(k)} = "${v}"`)
    .join("\n");
  return `[tools]\n${entries}\n`;
}

function servicesSection(services: string[], allTools: Record<string, string>): string {
  const sections: string[] = [];
  for (const svc of services) {
    const tmpl = SERVICE_TEMPLATES[svc];
    if (!tmpl) continue;
    // Add tool to tools if needed (handled outside)
    sections.push(
      `[services.${svc}]\nlogin = "${tmpl.login}"\ncheck = "${tmpl.check}"`
    );
  }
  return sections.join("\n\n");
}

export type SecretsStore =
  | "1password"
  | "infisical"
  | "bitwarden"
  | "doppler"
  | "vault"
  | "aws-sm"
  | "gcp-sm"
  | "azure-kv"
  | "env";

function secretsSection(services: string[], store: SecretsStore = "1password"): string {
  const allKeys: string[] = [];
  for (const svc of services) {
    const tmpl = SERVICE_TEMPLATES[svc];
    if (tmpl?.secrets.length) allKeys.push(...tmpl.secrets);
  }
  if (allKeys.length === 0) return "";

  const keyLines = allKeys.map((k) => {
    let src: string;
    switch (store) {
      case "1password":
        src = `source = "1password", ref = "op://Dev/Project/${k}"`;
        break;
      case "infisical":
        src = `source = "infisical", name = "${k}"`;
        break;
      case "bitwarden":
        src = `source = "bitwarden", name = "${k}"`;
        break;
      case "doppler":
        src = `source = "doppler", name = "${k}"`;
        break;
      case "vault":
        src = `source = "vault", vault_path = "secret/data/myapp", vault_field = "${k}"`;
        break;
      case "aws-sm":
        src = `source = "aws-sm", name = "${k}"`;
        break;
      case "gcp-sm":
        src = `source = "gcp-sm", name = "${k}"`;
        break;
      case "azure-kv":
        src = `source = "azure-kv", name = "${k}"`;
        break;
      default:
        src = `source = "env"`;
    }
    return `${k} = { ${src} }`;
  });

  return lines(
    `[secrets]`,
    `store = "${store}"`,
    `template = ".env.template"`,
    ``,
    `[secrets.keys]`,
    keyLines.join("\n")
  );
}

function setupSection(stack: DetectedStack): string {
  const frameworkSetup = stack.framework ? FRAMEWORK_SETUP[stack.framework] : null;

  // Detect package manager from tools
  let installCmd: string;
  if (stack.tools.pnpm) installCmd = "pnpm install";
  else if (stack.tools.yarn) installCmd = "yarn install";
  else if (stack.tools.bun) installCmd = "bun install";
  else if (stack.tools.uv) installCmd = "uv sync";
  else if (stack.language === "go") installCmd = "go mod download";
  else if (stack.language === "rust") installCmd = "cargo fetch";
  else if (stack.language === "php") installCmd = "composer install";
  else installCmd = frameworkSetup?.install ?? "npm install";

  const hasSupabase = stack.services.includes("supabase");
  const hasPrisma = stack.services.includes("prisma");
  const hasDrizzle = stack.services.includes("drizzle");

  let migrateCmd: string | null = null;
  if (hasSupabase) migrateCmd = "supabase db push";
  else if (hasPrisma) migrateCmd = "npx prisma migrate deploy";
  else if (hasDrizzle) migrateCmd = "npx drizzle-kit migrate";
  else if (frameworkSetup?.migrate) migrateCmd = frameworkSetup.migrate;

  const verifyCmd = frameworkSetup?.verify ?? null;

  const parts: string[] = [`[setup]`, `install = "${installCmd}"`];
  if (migrateCmd) parts.push(`migrate = "${migrateCmd}"`);
  if (verifyCmd) parts.push(`verify = "${verifyCmd}"`);

  return parts.join("\n");
}

/**
 * Generate a .kit.toml string from a detected stack profile.
 */
export function generateToml(
  stack: DetectedStack,
  options: { secretsStore?: SecretsStore } = {},
): string {
  // Merge service tools into tools map
  const tools = { ...stack.tools };
  for (const svc of stack.services) {
    const tmpl = SERVICE_TEMPLATES[svc];
    if (tmpl?.tool && !tools[tmpl.tool]) {
      tools[tmpl.tool] = "latest";
    }
  }

  // Default security scanners — mise-provisioned and on by default, so
  // `kit check` runs them out of the box (kit orchestrates scanners; it
  // shouldn't just warn they're missing). semgrep = SAST (your code);
  // socket = supply-chain (your deps). Remove from [tools] to opt out.
  for (const [tool, ref] of Object.entries(DEFAULT_SECURITY_SCANNERS)) {
    if (!tools[tool]) tools[tool] = ref;
  }

  const header = lines(
    `# .kit.toml — generated by kit init`,
    stack.framework
      ? `# Detected: ${stack.language} / ${stack.framework}${stack.services.length ? ` + ${stack.services.join(", ")}` : ""}`
      : `# Detected: ${stack.language}${stack.services.length ? ` + ${stack.services.join(", ")}` : ""}`,
    `# Includes default security scanners (semgrep, socket) installed via mise.`,
    ``
  );

  const toolsSec = toolsSection(tools);
  const servicesSec = servicesSection(stack.services, tools);
  const secretsSec = secretsSection(stack.services, options.secretsStore ?? "1password");
  const setupSec = setupSection(stack);

  const parts = [header, toolsSec, servicesSec, secretsSec, setupSec].filter(
    (s) => s.trim().length > 0
  );

  return parts.join("\n") + "\n";
}
