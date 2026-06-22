/**
 * Single source of truth for the services kit detects and wires up.
 *
 * This unifies two tables that used to live apart and drift: the detection
 * table (which deps/files mean "this repo uses X") in stack-detector.ts, and the
 * generation table (X's login/check/secret-keys/tool) in toml-generator.ts.
 * Keeping them as one `ServiceDef` per service means:
 *   - adding a service (or a whole new DB/BaaS) is ONE data entry, not edits to
 *     two files that must be kept in sync;
 *   - detection is language-agnostic: a Python or Go repo that uses Stripe now
 *     gets `services: ["stripe"]` (the per-language detectors used to hardcode
 *     `services: []`, so the whole secret/login layer was Node-only).
 *
 * stack-detector.ts calls {@link detectServices}; toml-generator.ts reads
 * {@link SERVICE_BY_ID}. Registry ORDER is detection + emit order — keep it
 * stable (tests pin "supabase before stripe", and migrate precedence is
 * "first detected service that declares a `migrate`", so supabase must precede
 * prisma/drizzle here).
 */
export interface ServiceDef {
  id: string;
  // ── detection signals (any match ⇒ detected) ──
  /** node: exact package name in dependencies/devDependencies. */
  deps?: string[];
  /** python: substring matched (case-insensitive) in requirements.txt/pyproject.toml. */
  pyDeps?: string[];
  /** go: substring matched in go.mod (module path). */
  goMods?: string[];
  /** marker files/dirs, any language (checked relative to repo root). */
  files?: string[];
  // ── generation (all optional) ──
  /** login command, or a `#`-prefixed informational note when there's no CLI. */
  login?: string;
  /** verify command, or a `#`-prefixed informational note. */
  check?: string;
  /** env keys this service needs. */
  secrets?: string[];
  /** mise tool to add to [tools] when this service is present. */
  tool?: string;
  /** migrate command — first detected service that declares one wins (see setupSection). */
  migrate?: string;
}

export const SERVICE_REGISTRY: ServiceDef[] = [
  // ── existing 16 (ported verbatim from SERVICE_DETECTORS + SERVICE_TEMPLATES;
  //    strings preserved exactly for byte-identical output) ──
  {
    id: "stripe",
    deps: ["stripe"],
    pyDeps: ["stripe"],
    goMods: ["github.com/stripe/stripe-go"],
    login: "stripe login",
    check: "stripe config --list",
    secrets: ["STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_WEBHOOK_SECRET"],
    tool: "stripe",
  },
  {
    id: "supabase",
    deps: ["@supabase/supabase-js"],
    pyDeps: ["supabase"],
    files: ["supabase"],
    login: "supabase login",
    check: "supabase projects list",
    secrets: ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"],
    tool: "supabase",
    migrate: "supabase db push",
  },
  {
    id: "prisma",
    deps: ["prisma", "@prisma/client"],
    migrate: "npx prisma migrate deploy",
  },
  {
    id: "resend",
    deps: ["resend"],
    pyDeps: ["resend"],
    login: "# resend — no CLI login; set RESEND_API_KEY in env",
    check: "# resend — check RESEND_API_KEY is set",
    secrets: ["RESEND_API_KEY", "RESEND_FROM_EMAIL"],
  },
  {
    id: "clerk",
    deps: ["@clerk/nextjs", "@clerk/clerk-react"],
    login: "# clerk — no CLI login; get keys from https://dashboard.clerk.com",
    check: "# clerk — check CLERK_SECRET_KEY is set",
    secrets: ["CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"],
  },
  {
    id: "drizzle",
    deps: ["drizzle-orm"],
    migrate: "npx drizzle-kit migrate",
  },
  {
    id: "liveblocks",
    deps: ["liveblocks", "@liveblocks/client"],
    login: "# liveblocks — no CLI login; get keys from https://liveblocks.io/dashboard",
    check: "# liveblocks — check LIVEBLOCKS_SECRET_KEY is set",
    secrets: ["LIVEBLOCKS_SECRET_KEY", "NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY"],
  },
  {
    id: "trigger",
    deps: ["@trigger.dev/sdk", "trigger.dev"],
    login: "# trigger — no CLI login; get key from https://cloud.trigger.dev",
    check: "# trigger — check TRIGGER_SECRET_KEY is set",
    secrets: ["TRIGGER_SECRET_KEY"],
  },
  {
    id: "inngest",
    deps: ["inngest"],
    login: "# inngest — no CLI login; get keys from https://app.inngest.com",
    check: "# inngest — check INNGEST_EVENT_KEY is set",
    secrets: ["INNGEST_EVENT_KEY", "INNGEST_SIGNING_KEY"],
  },
  {
    id: "vercel",
    deps: ["@vercel/analytics", "vercel"],
    files: ["vercel.json"],
    login: "vercel login",
    check: "vercel whoami",
    secrets: [],
    tool: "vercel",
  },
  {
    id: "expo",
    files: [".expo"],
    login: "eas login",
    check: "eas whoami",
    secrets: ["EXPO_TOKEN"],
    tool: "eas-cli",
  },
  {
    id: "sentry",
    deps: ["@sentry/nextjs", "@sentry/node", "@sentry/react", "@sentry/svelte", "@sentry/astro", "@sentry/remix"],
    pyDeps: ["sentry-sdk"],
    goMods: ["github.com/getsentry/sentry-go"],
    login: "# sentry — no CLI login; get DSN from https://sentry.io",
    check: "# sentry — check SENTRY_DSN is set",
    secrets: ["SENTRY_DSN", "SENTRY_ORG", "SENTRY_PROJECT", "SENTRY_AUTH_TOKEN"],
  },
  {
    id: "typeorm",
    deps: ["typeorm", "@nestjs/typeorm"],
    login: "# typeorm — no CLI login; configure DATABASE_URL",
    check: "# typeorm — check DATABASE_URL is set",
    secrets: ["DATABASE_URL"],
  },
  {
    id: "mongoose",
    deps: ["mongoose", "@nestjs/mongoose"],
    login: "# mongoose — no CLI login; configure MONGODB_URI",
    check: "# mongoose — check MONGODB_URI is set",
    secrets: ["MONGODB_URI"],
  },
  {
    id: "netlify",
    files: ["netlify.toml"],
    login: "netlify login",
    check: "netlify status",
    secrets: ["NETLIFY_AUTH_TOKEN", "NETLIFY_SITE_ID"],
    tool: "netlify",
  },
  {
    id: "cloudflare-pages",
    files: ["wrangler.toml"],
    login: "wrangler login",
    check: "wrangler whoami",
    secrets: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
    tool: "wrangler",
  },

  // ── new entries (init-v2): databases / BaaS / warehouses. The whole point of
  //    the registry is that these are just data. New strings use plain hyphens
  //    (no em-dashes), per the project's written-content rule. ──
  {
    id: "convex",
    deps: ["convex"],
    login: "# convex - run `npx convex dev` to log in + create a deployment",
    check: "# convex - check CONVEX_DEPLOYMENT is set",
    secrets: ["CONVEX_DEPLOYMENT", "NEXT_PUBLIC_CONVEX_URL"],
  },
  {
    id: "firebase",
    deps: ["firebase", "firebase-admin"],
    files: ["firebase.json", ".firebaserc"],
    login: "firebase login",
    check: "firebase projects:list",
    secrets: ["FIREBASE_API_KEY", "FIREBASE_PROJECT_ID", "GOOGLE_APPLICATION_CREDENTIALS"],
    tool: "firebase",
  },
  {
    id: "mysql",
    deps: ["mysql", "mysql2"],
    pyDeps: ["mysqlclient", "pymysql"],
    login: "# mysql - no CLI login; configure DATABASE_URL",
    check: "# mysql - check DATABASE_URL is set",
    secrets: ["DATABASE_URL"],
  },
  {
    id: "planetscale",
    deps: ["@planetscale/database"],
    login: "# planetscale - configure DATABASE_URL (or run `pscale auth login`)",
    check: "# planetscale - check DATABASE_URL is set",
    secrets: ["DATABASE_URL"],
  },
  {
    id: "neon",
    deps: ["@neondatabase/serverless"],
    login: "# neon - configure DATABASE_URL from the Neon console",
    check: "# neon - check DATABASE_URL is set",
    secrets: ["DATABASE_URL"],
  },
  {
    id: "turso",
    deps: ["@libsql/client"],
    login: "turso auth login",
    check: "turso auth whoami",
    secrets: ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"],
    tool: "turso",
  },
  {
    id: "bigquery",
    deps: ["@google-cloud/bigquery"],
    pyDeps: ["google-cloud-bigquery"],
    login: "gcloud auth application-default login",
    check: "# bigquery - check GOOGLE_APPLICATION_CREDENTIALS + GCP_PROJECT_ID are set",
    secrets: ["GOOGLE_APPLICATION_CREDENTIALS", "GCP_PROJECT_ID"],
  },
  {
    id: "snowflake",
    deps: ["snowflake-sdk"],
    pyDeps: ["snowflake-connector-python"],
    login: "# snowflake - no CLI login; set SNOWFLAKE_* connection vars",
    check: "# snowflake - check SNOWFLAKE_ACCOUNT is set",
    secrets: ["SNOWFLAKE_ACCOUNT", "SNOWFLAKE_USER", "SNOWFLAKE_PASSWORD"],
  },
  {
    id: "redshift",
    deps: ["@aws-sdk/client-redshift", "@aws-sdk/client-redshift-data"],
    login: "# redshift - no CLI login; set DATABASE_URL (or assume an IAM role)",
    check: "# redshift - check DATABASE_URL is set",
    secrets: ["DATABASE_URL"],
  },
  {
    id: "redis",
    deps: ["@upstash/redis", "ioredis", "redis"],
    pyDeps: ["redis"],
    login: "# redis - no CLI login; set REDIS_URL (or UPSTASH_REDIS_REST_*)",
    check: "# redis - check REDIS_URL is set",
    secrets: ["REDIS_URL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
  },
  {
    id: "auth0",
    deps: ["@auth0/nextjs-auth0", "@auth0/auth0-react", "auth0"],
    login: "# auth0 - no CLI login; get keys from https://manage.auth0.com",
    check: "# auth0 - check AUTH0_CLIENT_ID is set",
    secrets: ["AUTH0_SECRET", "AUTH0_BASE_URL", "AUTH0_ISSUER_BASE_URL", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET"],
  },
  {
    id: "keycloak",
    deps: [
      "keycloak-js",
      "keycloak-connect",
      "keycloak-admin-client",
      "@keycloak/keycloak-admin-client",
      "keycloak-angular",
    ],
    pyDeps: ["python-keycloak"],
    goMods: ["github.com/Nerzal/gocloak"],
    // Keycloak is a self-hosted server (run via Docker/standalone), not a mise
    // CLI — so no `tool`; admin is the server's own kcadm.sh.
    login: "# keycloak - no CLI login; admin via the server's kcadm.sh or set KEYCLOAK_* env",
    check: "# keycloak - verify KEYCLOAK_URL + realm are reachable",
    secrets: [
      "KEYCLOAK_URL",
      "KEYCLOAK_REALM",
      "KEYCLOAK_CLIENT_ID",
      "KEYCLOAK_CLIENT_SECRET",
      "KEYCLOAK_ADMIN",
      "KEYCLOAK_ADMIN_PASSWORD",
    ],
  },
  {
    id: "atlassian",
    // Bitbucket Pipelines is the one reliable in-repo Atlassian marker; Jira/
    // Confluence usage isn't detectable from a checkout, so detection is
    // conservative (acli still covers all three once installed).
    files: ["bitbucket-pipelines.yml", ".bitbucket"],
    // acli auth is interactive + subcommand-specific; left as a note so kit
    // doesn't run a guessed login. The CLI itself is provisioned via mise.
    login: "# atlassian - run the acli auth flow (acli --help); needs ATLASSIAN_API_TOKEN",
    check: "# atlassian - check ATLASSIAN_API_TOKEN is set",
    secrets: ["ATLASSIAN_API_TOKEN", "ATLASSIAN_SITE_URL"],
    tool: "acli",
  },
];

/** Lookup by service id, for the generator. */
export const SERVICE_BY_ID: Record<string, ServiceDef> = Object.fromEntries(
  SERVICE_REGISTRY.map((s) => [s.id, s]),
);

/**
 * Detect which services a repo uses, language-agnostically. Returns ids in
 * registry order. `fileExists` is repo-root-relative so each language detector
 * can pass its own cwd-bound checker.
 */
export async function detectServices(signals: {
  deps?: string[];
  pyText?: string;
  goMod?: string;
  fileExists: (relPath: string) => Promise<boolean>;
}): Promise<string[]> {
  const deps = signals.deps ?? [];
  const py = signals.pyText?.toLowerCase() ?? "";
  const go = signals.goMod ?? "";
  const out: string[] = [];

  for (const def of SERVICE_REGISTRY) {
    let hit = false;
    if (def.deps?.some((d) => deps.includes(d))) hit = true;
    if (!hit && py && def.pyDeps?.some((p) => py.includes(p.toLowerCase()))) hit = true;
    if (!hit && go && def.goMods?.some((m) => go.includes(m))) hit = true;
    if (!hit && def.files) {
      for (const f of def.files) {
        if (await signals.fileExists(f)) {
          hit = true;
          break;
        }
      }
    }
    if (hit) out.push(def.id);
  }
  return out;
}
