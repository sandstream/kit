/**
 * The grouped command list `kit help` prints. Every top-level command should appear in one group;
 * any command not listed still prints under "Other", so help can never silently drop one, and
 * src/help-categories.test.ts fails when a dispatched command is in no group.
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
      "bootstrap",
      "config",
      "tools",
      "profile",
    ],
  ],
  [
    "Review & quality",
    [
      "review",
      "design",
      "standards",
      "coverage",
      "baseline",
      "analyze",
      "monkey-test",
      "adr",
      "rig",
      "self-audit",
      "map",
      "browser",
    ],
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
      "slopsquat",
      "airgap",
      "broker",
    ],
  ],
  [
    "Agents & memory",
    ["memory", "agent-config", "mcp", "skills", "skill", "context", "hooks", "insight"],
  ],
  [
    "Governance & access",
    ["governance", "audit", "decisions", "auth", "team", "escalate", "identity", "panic", "policy"],
  ],
  ["Packages & services", ["pkg", "add", "plugin", "create-plugin", "run", "open", "ci"]],
  ["Meta", ["whoami", "usage", "version", "completions", "help"]],
];
