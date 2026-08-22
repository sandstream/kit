/**
 * kit's declared CONFIGURATION SURFACE — every `.kit.toml` section, what it is for, and what
 * declaring it buys.
 *
 * WHY THIS EXISTS. `.kit.toml` has 23 sections. Six of the most-used ones — `[tools]`, `[services]`,
 * `[secrets]`, `[skills]`, `[governance]`, `[hooks]` — carried no description anywhere in the type,
 * two (`[mcp]`, `[supply_chain]`) appeared in no document at all, and the rest were explained in
 * passing across thirty-odd files. `kit config knobs` listed 30 knobs covering four sections. So
 * "what can I configure, and where do I change it?" had no answer surface — not in the docs, not
 * from the CLI. This table is that answer, and `kit config sections` prints it.
 *
 * WHY A TABLE AND NOT PROSE IN A DOC: a hand-written reference rots silently. The test beside this
 * file scans `kitConfig` in `src/config.ts` and fails in BOTH directions — a section in the type
 * that is missing here, and an entry here that is not a real section. Unlike the flag surface,
 * over-documenting is also an error: a section that no longer exists sends the reader looking for
 * something kit will ignore.
 *
 * `docs/CONFIGURATION.md` is generated from this table, so the doc cannot drift from the code
 * either. Deterministic, not static.
 *
 * Each entry answers three questions and nothing else: what the section IS, what declaring it
 * BUYS (the reason to bother), and the smallest EXAMPLE that does something real.
 */

export interface ConfigSection {
  /** One line: what this section configures. */
  purpose: string;
  /** What declaring it buys — the operator's reason to care, not a restatement of the name. */
  buys: string;
  /** The smallest snippet that does something real. */
  example: string;
  /** Fuller treatment, when a document covers it. */
  docs?: string;
  /** The command that sets it up or inspects it, when one exists. */
  command?: string;
}

export const CONFIG_SECTIONS: Record<string, ConfigSection> = {
  version: {
    purpose: "Schema version of this file, as a top-level integer.",
    buys: "The config contract is frozen: kit can migrate an older file forward instead of guessing what an unknown shape meant.",
    example: "version = 1",
    command: "kit config migrate",
  },
  tools: {
    purpose: "Tool versions this project requires, provisioned through mise.",
    buys: "Everyone — and CI — runs the same versions, and `kit check` reports a drifted toolchain as a red row instead of a mystery failure.",
    example: '[tools]\nnode = "22"\npython = "3.12"',
    command: "kit install",
  },
  services: {
    purpose:
      "External CLIs this project authenticates against, with the login and check command for each.",
    buys: '"Am I logged in to the right things?" becomes one command rather than a per-tool guess.',
    example: '[services.github]\nlogin = "gh auth login"\ncheck = "gh auth status"',
    command: "kit login",
  },
  setup: {
    purpose: "Project bootstrap commands — install dependencies, migrate, verify.",
    buys: "A fresh clone reaches a working state from one command, in the order the project actually needs.",
    example: '[setup]\ninstall = "npm ci"\nverify = "npm test"',
    command: "kit bootstrap",
  },
  secrets: {
    purpose: "Which vault backs this project's secrets, and the key names it needs.",
    buys: "Keys are declared by NAME and resolved from a vault, so a plaintext value never has to exist in the repo — and a missing key is a check failure, not a runtime surprise.",
    example:
      '[secrets]\nstore = "1password"\n\n[secrets.keys]\nSTRIPE_SECRET_KEY = { source = "1password" }',
    docs: "docs/ENV_FUELING.md",
    command: "kit secrets",
  },
  skills: {
    purpose: "Agent skills this project requires or offers, and the registry to fetch them from.",
    buys: "Every agent working in the repo gets the same skills, pinned, instead of whatever each developer happens to have installed.",
    example: '[skills]\nrequired = { triage = "^1" }',
    docs: "docs/SKILLS_ARCHITECTURE.md",
    command: "kit skills",
  },
  governance: {
    purpose:
      "Whether agent operations are audited, under which environment, and the access/approval rules around them.",
    buys: "Agent actions produce a hash-chained evidence trail, and destructive ones can require approval — the difference between trusting an agent and being able to show what it did.",
    example: '[governance]\nenabled = true\nenvironment = "dev"',
    docs: "docs/ENFORCEMENT_AND_AUDIT.md",
    command: "kit governance",
  },
  hooks: {
    purpose: "Git hooks kit installs, and the commands each one runs.",
    buys: "The floor runs before a commit or push instead of after review — a staged credential is refused while it is still local.",
    example: '[hooks]\npre-commit = ["kit security scan-staged"]',
    command: "kit hooks add secret-scan",
  },
  deploy: {
    purpose: "Required platform env-var NAMES per project and environment.",
    buys: "`kit check --category deploy` diffs the names your platform has against the names this repo needs — without reading a single value.",
    example:
      '[deploy.vercel.environments.production]\nproject = "my-app"\nrequired = ["DATABASE_URL", "STRIPE_SECRET_KEY"]',
    command: "kit check --category deploy",
  },
  browser: {
    purpose: "Browser-verification capability declaration.",
    buys: "kit can diagnose the local browser automation setup instead of a UI check failing for an unrelated reason.",
    example: "[browser]\nenabled = true",
    command: "kit browser",
  },
  agent_config: {
    purpose:
      "How `kit agent-config` generates the rules files agents read (CLAUDE.md, AGENTS.md, …).",
    buys: "Every harness gets the same project rules from one source, so a rule added once reaches Claude Code, Codex and Cursor alike.",
    example: "[agent_config]\nuser_rules = { include = true }",
    command: "kit agent-config",
  },
  context: {
    purpose: "The account and project each CLI must be pointed at, per tool.",
    buys: "A tool answering as the wrong org becomes a red row instead of a filtered result set that looks complete — and a pre-push hook can block the wrong-project push outright.",
    example: '[context.gcloud]\naccount = "me@example.com"\nproject = "acme-prod"',
    command: "kit context check",
  },
  supply_chain: {
    purpose: "Install-time triage settings — notably which package scopes count as internal.",
    buys: "A first-party scope is not triaged as an unknown third-party package, so the gate stops crying wolf on your own code.",
    example: '[supply_chain]\ninternal_scopes = ["@acme"]',
    command: "kit supply-chain",
  },
  scan: {
    purpose:
      "Scanner settings: which delegates run, the GuardDog toggle, a vault project for scanner tokens, and the client-exposed env allowlist.",
    buys: "The scan set is declared instead of improvised, and a deliberately allowed exception carries its reason next to it.",
    example: '[scan]\nguarddog = true\ndelegates = ["osv-scanner", "trivy"]',
    command: "kit scan --list-delegates",
  },
  air_gap: {
    purpose:
      "No-egress posture: mirrors, offline threat data, and offline provenance verification.",
    buys: "The enclave's configuration is checked in and reproducible rather than living in one operator's shell environment.",
    example: '[air_gap]\nenabled = true\nnpm_registry = "https://npm.internal"',
    docs: "docs/AIR_GAP.md",
  },
  web: {
    purpose: "Web-search provider used by the features that need one.",
    buys: "Search runs through a provider you chose and can point at your own instance, rather than an implicit default.",
    example: '[web.search]\nprovider = "brave"',
    docs: "docs/PERFORMANCE_AND_DIAGNOSTICS.md",
  },
  env: {
    purpose: "Per-environment overrides of any section above.",
    buys: "Staging and production differ in the file instead of in someone's memory.",
    example: '[env.production.secrets]\nstore = "1password"',
  },
  mcp: {
    purpose: "Declared MCP-server connections for this project.",
    buys: "The servers an agent may reach are declared and reviewable, instead of whatever each developer has wired locally.",
    example:
      '[mcp.servers.github]\ncommand = "npx"\nargs = ["-y", "@modelcontextprotocol/server-github"]',
    docs: "docs/MCP_TOOLS_GUIDE.md",
  },
  policy: {
    purpose: "Which vendor writes an agent may perform, pre-approved by operation.",
    buys: "An agent's write is checked against a declared list at kit's choke points — and an empty list is a lock, not a wildcard.",
    example: '[policy.agent_writes]\nvercel = ["env:add"]',
    docs: "docs/POLICY.md",
    command: "kit governance",
  },
  memory: {
    purpose: "Memory capture and PAL behaviour, including this project's sensitivity class.",
    buys: "What was decided survives the session, in a local store you own, classified so a restricted project is not indexed like a public one.",
    example: '[memory]\ndefault_class = "internal"\ntrack_findings = true',
    docs: "docs/MEMORY.md",
    command: "kit memory",
  },
  update: {
    purpose: "Whether kit surfaces a newer published version, and whether it may self-update.",
    buys: "A pinned fleet stays pinned, and an operator who wants the banner keeps it — the choice is in the repo rather than in each shell.",
    example: "[update]\ncheck = true",
    command: "kit upgrade --self",
  },
  coverage: {
    purpose: "Which standards the evidence map scores against.",
    buys: "The coverage report covers the standards you are actually asked about, rather than all eight.",
    example: '[coverage]\nstandards = ["asvs", "ssdf"]',
    docs: "docs/STANDARDS.md",
    command: "kit coverage --list-standards",
  },
  standards: {
    purpose: "The deterministic dev-standards gate, and whether it fails on net-new findings.",
    buys: "Code standards are enforced by a gate with a baseline instead of by review memory.",
    example: "[standards]\nenforce = true",
    docs: "docs/STANDARDS.md",
    command: "kit standards",
  },
};

/** Section names kit accepts, sorted — the denominator for "what can I configure?". */
export function configSectionNames(): string[] {
  return Object.keys(CONFIG_SECTIONS).sort();
}
