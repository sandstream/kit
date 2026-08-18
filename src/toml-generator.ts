import type { DetectedStack } from "./stack-detector.js";
import { VAULT_META } from "./vault-meta.js";
import { SERVICE_BY_ID } from "./service-registry.js";

/**
 * A field kit deliberately did NOT write, because the repo does not prove it.
 *
 * The rule this type exists to enforce: a generated value that is merely plausible is
 * worse than an absent one. An absent line is a question; a plausible line looks like a
 * decision somebody made, so nobody re-reads it. Every wrong line in the .kit.toml this
 * generator used to produce — a vault the user does not use, a `pnpm build` verify that
 * would have deployed a backend, an `.env.template` that does not exist — was plausible.
 *
 * `owner` says who can close the gap, which is the only distinction that matters at the
 * point of use: an "agent" gap is one a reader of the repo can settle (which script is
 * the safe gate, which vault this developer runs); a "human" gap needs authority an agent
 * must not assume — credentials, vault sign-in, anything that writes to a remote.
 */
export interface InitGap {
  /** Dotted config path that was left out, e.g. `setup.verify`. */
  path: string;
  owner: "agent" | "human";
  /** What evidence was missing — phrased so the reader can go look for it. */
  why: string;
  /** Concrete options kit found but will not choose between. */
  candidates?: string[];
  /** The exact command that closes the gap. */
  fix: string;
}

export interface GeneratedConfig {
  toml: string;
  gaps: InitGap[];
}

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

/**
 * The multi-language tools the GENERAL `kit standards` gate delegates to, keyed by
 * mise tool ref → version. NOT added to a generated .kit.toml by default (standards
 * is opt-in): a project that wants the gate provisions these, and `kit standards`
 * resolves each bin mise-first (falling back to PATH), reporting a setup gap when
 * one is absent. lizard = complexity, jscpd = duplication, scc = size/shape.
 */
export const DEFAULT_STANDARDS_TOOLS: Record<string, string> = {
  "pipx:lizard": "latest",
  "npm:jscpd": "latest",
  "aqua:boyter/scc": "latest",
};

/**
 * Install commands a LANGUAGE determines on its own — no framework, lockfile or
 * package-manager choice involved. `go mod download` is not a guess about a Go repo;
 * it is what Go is.
 *
 * Deliberately short. Java (gradle vs maven), Python (uv vs poetry vs pip), Node
 * (npm vs pnpm vs yarn vs bun) and the mobile toolchains all have a real choice in
 * them, so they are resolved from a detected tool or left as a gap.
 */
const INSTALL_BY_LANGUAGE: Record<string, string> = {
  go: "go mod download",
  rust: "cargo fetch",
  php: "composer install",
  ruby: "bundle install",
};

/** Package managers, in the order a detected tool settles the install command. */
const INSTALL_BY_TOOL: [tool: string, command: string][] = [
  ["pnpm", "pnpm install"],
  ["yarn", "yarn install"],
  ["bun", "bun install"],
  ["uv", "uv sync"],
];

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

/**
 * Render `[secrets]`, or report the gap that stops us.
 *
 * There is no default store, on purpose. Defaulting to one wrote `op://Dev/Project/KEY`
 * refs into repos whose owner runs Infisical: refs shaped exactly like real ones, pointing
 * at nothing, in a file that reads as configured. Which vault a developer uses is not
 * knowable from their code — so it is asked for, never assumed.
 */
function secretsSection(
  services: string[],
  store: SecretsStore | undefined,
  extraKeys: string[],
  envTemplateFile: string | undefined,
): { section: string; gaps: InitGap[] } {
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
  if (allKeys.length === 0) return { section: "", gaps: [] };

  if (!store) {
    return {
      section: "",
      gaps: [
        {
          path: "secrets.store",
          owner: "agent",
          why:
            `${allKeys.length} secret key(s) are in play but no vault binding was found ` +
            `(.infisical.json, doppler.yaml, existing op:// refs: none)`,
          fix: `kit init --store <infisical|1password|doppler|vault|aws-sm|gcp-sm|azure-kv|bitwarden|env>`,
        },
      ],
    };
  }

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

  return {
    section: lines(
      `[secrets]`,
      `store = "${store}"`,
      // Only ever point at a file that exists. The old hardcoded `.env.template`
      // sent kit to a path most repos do not have.
      envTemplateFile ? `template = "${envTemplateFile}"` : undefined,
      ``,
      `[secrets.keys]`,
      keyLines.join("\n"),
      bindingBlock || undefined,
    ),
    gaps: [],
  };
}

/**
 * Render `[setup]`, plus a gap for every command kit refuses to invent.
 *
 * `verify` is ALWAYS a gap. It is the one command kit runs as a gate, and nothing in a
 * repo declares which script is safe to run for that purpose: in the repo that prompted
 * this, `build` began with `convex deploy`, so the generated `verify` would have deployed
 * a backend on every `kit setup`. Reading the scripts and choosing is a judgement, and
 * judgements belong to whoever can read the repo — not to a table keyed by framework name.
 */
function setupSection(
  stack: DetectedStack,
  opts: { verify?: string; install?: string; packageScripts?: string[] },
): { section: string; gaps: InitGap[] } {
  const gaps: InitGap[] = [];

  let installCmd: string | null = opts.install ?? null;
  if (!installCmd) {
    for (const [tool, command] of INSTALL_BY_TOOL) {
      if (stack.tools[tool]) {
        installCmd = command;
        break;
      }
    }
  }
  installCmd ??= INSTALL_BY_LANGUAGE[stack.language] ?? null;

  if (!installCmd) {
    gaps.push({
      path: "setup.install",
      owner: "agent",
      why: `no lockfile or package manager was detected for ${stack.language}, and the install command is a choice (npm/pnpm/yarn/bun, uv/poetry/pip, gradle/maven)`,
      fix: `kit init --install "<command>"`,
    });
  }

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

  if (!opts.verify) {
    gaps.push({
      path: "setup.verify",
      owner: "agent",
      why: "nothing in the repo says which command is safe to run as a gate — a build script may deploy",
      ...(opts.packageScripts?.length ? { candidates: opts.packageScripts } : {}),
      fix: `kit init --verify "<command>"`,
    });
  }

  const parts: string[] = [];
  if (installCmd) parts.push(`install = "${installCmd}"`);
  if (migrateCmd) parts.push(`migrate = "${migrateCmd}"`);
  if (opts.verify) parts.push(`verify = "${opts.verify}"`);

  return { section: parts.length ? `[setup]\n${parts.join("\n")}` : "", gaps };
}

/**
 * Generate a .kit.toml from a detected stack, plus the list of fields that were left
 * out because the repo does not prove them. The caller decides what to do with the
 * gaps — print them for a human, hand them to an agent, or fail a CI run.
 */
export function generateToml(
  stack: DetectedStack,
  options: {
    secretsStore?: SecretsStore;
    hasDockerfile?: boolean;
    extraSecretKeys?: string[];
    /** Name of the env template that actually exists in the repo. */
    envTemplateFile?: string;
    /** Supplied by `--verify` or by an agent that read the repo. */
    verify?: string;
    /** Supplied by `--install` when no lockfile settles the package manager. */
    install?: string;
    /** package.json scripts, offered as candidates on the verify gap. */
    packageScripts?: string[];
  } = {},
): GeneratedConfig {
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
  // No store chosen means no vault CLI: kit will not install a vault the user
  // never asked for (a defaulted `1password` entry here is what `kit triage`
  // blocked, taking the whole setup run down with it).
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
  const secrets = secretsSection(
    stack.services,
    options.secretsStore,
    options.extraSecretKeys ?? [],
    options.envTemplateFile,
  );
  const setup = setupSection(stack, {
    ...(options.verify ? { verify: options.verify } : {}),
    ...(options.install ? { install: options.install } : {}),
    ...(options.packageScripts ? { packageScripts: options.packageScripts } : {}),
  });

  // One blank line between sections, regardless of whether a section renderer
  // happened to end with a newline of its own — `[services.x]` used to butt
  // straight up against `[secrets]`, which parses fine and reads badly.
  const parts = [header, toolsSec, servicesSec, secrets.section, setup.section]
    .map((s) => s.trimEnd())
    .filter((s) => s.length > 0);

  return { toml: parts.join("\n\n") + "\n", gaps: [...secrets.gaps, ...setup.gaps] };
}
