/**
 * The grouped command list `kit help` prints. Every top-level command should appear in one group;
 * any command not listed still prints under "Other", so help can never silently drop one.
 */
export const HELP_CATEGORIES: [string, string[]][] = [
  [
    "Setup & lifecycle",
    [
      "init",
      "setup",
      "install",
      "upgrade",
      "clone",
      "fix",
      "heal",
      "doctor",
      "status",
      "check",
      "health",
    ],
  ],
  [
    "Review & quality",
    ["review", "design", "standards", "coverage", "baseline", "analyze", "monkey-test"],
  ],
  ["Secrets & environments", ["secrets", "env", "login"]],
  [
    "Security & supply chain",
    [
      "scan",
      "security",
      "triage",
      "guard",
      "supply-chain",
      "sbom",
      "gha-audit",
      "upstream",
      "agent-audit",
      "verify-provenance",
      "ingest",
      "sentinel",
    ],
  ],
  ["Agents & memory", ["memory", "agent-config", "mcp", "skills", "context", "hooks"]],
  [
    "Governance & access",
    ["governance", "audit", "decisions", "auth", "team", "escalate", "identity", "panic", "policy"],
  ],
  ["Packages & services", ["pkg", "add", "plugin", "create-plugin", "run", "open", "ci"]],
  ["Meta", ["whoami", "version", "completions", "help"]],
];
