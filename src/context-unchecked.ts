import type { ContextConfig } from "./config.js";
import type { ContextFinding } from "./context-lock.js";

/**
 * Keys kit reads under each `[context.<tool>]` section. The schema passes unknown keys through,
 * so a typo or a tool kit does not know is parsed without error and then never compared. A lock
 * that is not checked reads as a lock that holds, so each such key becomes an `unchecked` finding.
 */
const KNOWN: Record<string, readonly string[]> = {
  gcloud: ["account", "project", "config", "region"],
  vercel: ["team", "project", "user"],
  github: ["org", "remote", "user"],
  convex: ["account"],
  gitlab: ["group", "remote"],
  bitbucket: ["workspace", "remote"],
  ssh: ["identity", "fingerprint", "host_alias"],
  git: ["email"],
  npm: ["registry"],
  keycloak: ["realm"],
  auth0: ["tenant"],
  clerk: ["env"],
  terraform: ["bucket", "prefix", "workspace", "dir"],
};

function isTable(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Findings for sections and keys under `[context]` that no check consumes. Pure. */
export function uncheckedContext(ctx: ContextConfig | undefined): ContextFinding[] {
  const out: ContextFinding[] = [];
  for (const [tool, section] of Object.entries(ctx ?? {})) {
    const known = KNOWN[tool];
    if (!known) {
      out.push({
        tool,
        field: "(section)",
        status: "unchecked",
        expected: "known tool",
        actual: null,
      });
      continue;
    }
    if (!isTable(section)) continue;
    for (const key of Object.keys(section)) {
      if (known.includes(key)) continue;
      out.push({ tool, field: key, status: "unchecked", expected: "known key", actual: null });
    }
  }
  return out;
}
