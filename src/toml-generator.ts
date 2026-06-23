import type { DetectedStack } from "./stack-detector.js";
import { VAULT_META } from "./vault-meta.js";
import { SERVICE_BY_ID } from "./service-registry.js";

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
  django: {
    install: "uv sync",
    migrate: "uv run python manage.py migrate",
    verify: "uv run python manage.py check",
  },
  flask: { install: "uv sync", dev: "uv run flask run", verify: "uv run pytest" },
  gin: { install: "go mod download", dev: "go run .", verify: "go build ./..." },
  echo: { install: "go mod download", dev: "go run .", verify: "go build ./..." },
  fiber: { install: "go mod download", dev: "go run .", verify: "go build ./..." },
  laravel: {
    install: "composer install",
    migrate: "php artisan migrate",
    verify: "php artisan test",
  },
  symfony: { install: "composer install", verify: "php bin/console lint:all" },
  // native mobile
  "react-native": { install: "pnpm install", dev: "pnpm start", verify: "pnpm tsc --noEmit" },
  flutter: { install: "flutter pub get", dev: "flutter run", verify: "flutter analyze" },
  ios: { install: "pod install", verify: "swift build" },
  android: { install: "./gradlew dependencies", verify: "./gradlew build" },
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
  // trufflehog (single Go binary via aqua) → deep secret scan on by default;
  // `kit check` resolves the `trufflehog` bin mise-first and uses it instead of
  // the basic regex fallback.
  "aqua:trufflesecurity/trufflehog": "latest",
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

function servicesSection(services: string[]): string {
  const sections: string[] = [];
  for (const svc of services) {
    const def = SERVICE_BY_ID[svc];
    // Only services with a login/check get a [services.X] block. ORM-only
    // entries (prisma/drizzle) declare just deps+migrate, so they're skipped here.
    if (!def?.login || !def.check) continue;
    // Tools are merged into [tools] by generateToml; here we only emit login/check.
    sections.push(`[services.${svc}]\nlogin = "${def.login}"\ncheck = "${def.check}"`);
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

/** Extract env keys from a `.env.example`/`.env.template` file body —
 *  `^KEY=` lines (KEY = upper/underscore/digit). Comments + blanks ignored. */
export function parseEnvTemplateKeys(content: string): string[] {
  const keys: string[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/);
    if (m) keys.push(m[1]);
  }
  return keys;
}

function secretsSection(
  services: string[],
  store: SecretsStore = "1password",
  extraKeys: string[] = [],
): string {
  const allKeys: string[] = [];
  const seen = new Set<string>();
  const add = (k: string): void => {
    if (!seen.has(k)) {
      seen.add(k);
      allKeys.push(k);
    }
  };
  for (const svc of services) {
    const def = SERVICE_BY_ID[svc];
    def?.secrets?.forEach(add);
  }
  // Keys from an existing .env.example the project already documents (deduped
  // against service-template keys) — so a project's real secret contract is kept.
  extraKeys.forEach(add);
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

  // For Infisical, scaffold the project binding. `environment` is the one piece
  // we can know before login; `project_id` needs a logged-in session, so it's
  // left commented with a pointer to `infisical init` (writes .infisical.json).
  // Without this block the backend silently defaults to env="dev" with no
  // project, which is rarely what the user means.
  const bindingBlock =
    store === "infisical"
      ? `\n[secrets.infisical]\nenvironment = "dev"\n` +
        `# project_id = "..."   # run \`infisical login && infisical init\` to bind this repo`
      : "";

  return lines(
    `[secrets]`,
    `store = "${store}"`,
    `template = ".env.template"`,
    ``,
    `[secrets.keys]`,
    keyLines.join("\n"),
    bindingBlock || undefined,
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
  else if (stack.language === "dart") installCmd = frameworkSetup?.install ?? "dart pub get";
  else if (stack.language === "swift") installCmd = frameworkSetup?.install ?? "swift build";
  else if (stack.language === "kotlin") installCmd = frameworkSetup?.install ?? "./gradlew build";
  else installCmd = frameworkSetup?.install ?? "npm install";

  // First detected service that declares a migrate command wins. Registry order
  // puts supabase before prisma before drizzle, preserving the old precedence.
  let migrateCmd: string | null = null;
  for (const svc of stack.services) {
    const m = SERVICE_BY_ID[svc]?.migrate;
    if (m) {
      migrateCmd = m;
      break;
    }
  }
  if (!migrateCmd && frameworkSetup?.migrate) migrateCmd = frameworkSetup.migrate;

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
  options: {
    secretsStore?: SecretsStore;
    hasDockerfile?: boolean;
    extraSecretKeys?: string[];
  } = {},
): string {
  // Merge service tools into tools map
  const tools = { ...stack.tools };
  for (const svc of stack.services) {
    const def = SERVICE_BY_ID[svc];
    if (def?.tool && !tools[def.tool]) {
      tools[def.tool] = "latest";
    }
  }

  // Universal security scanners — mise-provisioned and on by default, so
  // `kit check` runs them out of the box (kit orchestrates scanners; it
  // shouldn't just warn they're missing). semgrep = SAST (your code);
  // socket = deps; trufflehog = secrets. Remove from [tools] to opt out.
  for (const [tool, ref] of Object.entries(DEFAULT_SECURITY_SCANNERS)) {
    if (!tools[tool]) tools[tool] = ref;
  }

  // Conditional scanners — only where they apply, to avoid noise/redundancy:
  //  - trivy: container/IaC, only when a Dockerfile is present (caller-detected).
  //  - pip-audit: Python dep CVEs.
  //  - osv-scanner: dep CVEs for ecosystems kit has no dedicated scanner for
  //    (go/rust/php/…). Skipped for node (npm audit) and python (pip-audit) to
  //    avoid duplicating their coverage.
  if (options.hasDockerfile && !tools["aqua:aquasecurity/trivy"]) {
    tools["aqua:aquasecurity/trivy"] = "latest";
  }
  if (stack.language === "python" && !tools["pipx:pip-audit"]) {
    tools["pipx:pip-audit"] = "latest";
  }
  const hasEcosystemScanner = ["typescript", "javascript", "python"].includes(stack.language);
  if (!hasEcosystemScanner && !tools["aqua:google/osv-scanner"]) {
    tools["aqua:google/osv-scanner"] = "latest";
  }

  // Provision the chosen vault's CLI so `kit setup` installs it like any other
  // tool. Choosing a vault used to record `store = "..."` and nothing else,
  // leaving the CLI absent and `kit secrets` failing key-by-key — fix that by
  // wiring the CLI in here. Cloud secret managers (no `miseTool`) ship their CLI
  // through the cloud env, so they're guided at login but not provisioned.
  const vaultTool =
    options.secretsStore &&
    VAULT_META[options.secretsStore as Exclude<SecretsStore, "env">]?.miseTool;
  if (vaultTool && !tools[vaultTool]) {
    tools[vaultTool] = "latest";
  }

  const header = lines(
    `# .kit.toml — generated by kit init`,
    stack.framework
      ? `# Detected: ${stack.language} / ${stack.framework}${stack.services.length ? ` + ${stack.services.join(", ")}` : ""}`
      : `# Detected: ${stack.language}${stack.services.length ? ` + ${stack.services.join(", ")}` : ""}`,
    `# Includes default security scanners (semgrep, socket) installed via mise.`,
    ``,
  );

  const toolsSec = toolsSection(tools);
  const servicesSec = servicesSection(stack.services);
  const secretsSec = secretsSection(
    stack.services,
    options.secretsStore ?? "1password",
    options.extraSecretKeys ?? [],
  );
  const setupSec = setupSection(stack);

  const parts = [header, toolsSec, servicesSec, secretsSec, setupSec].filter(
    (s) => s.trim().length > 0,
  );

  return parts.join("\n") + "\n";
}
