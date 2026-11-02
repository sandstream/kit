/** Review classes that require a person before merge. The rule file is protected too. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ProtectedClass = "release" | "github" | "secrets" | "permissions";
type Patterns = { exact: string[]; prefix: string[] };
export type ProtectedPathRules = Record<ProtectedClass, Patterns>;

const CLASSES: readonly ProtectedClass[] = ["release", "github", "secrets", "permissions"];

/** Built-in fallback for projects whose base has no rule file. */
export const DEFAULT_PROTECTED_PATH_RULES: ProtectedPathRules = {
  release: {
    exact: ["package.json", "package-lock.json", "docs/RELEASING.md"],
    prefix: [".github/workflows/publish", "packages/"],
  },
  github: { exact: [], prefix: [".github/"] },
  secrets: {
    exact: [
      "src/check-secrets.ts",
      "src/audit-secrets.ts",
      "src/agent-audit.ts",
      "src/utils/redactSecrets.ts",
    ],
    prefix: [
      "src/secrets",
      "src/secret-",
      "src/vault-",
      "src/keystore/",
      "src/audit-anchor",
      ".env",
    ],
  },
  permissions: {
    exact: [
      "src/agent-config.ts",
      "src/commands/gate.ts",
      "src/hook-floor.ts",
      "src/install-gate.ts",
    ],
    prefix: ["src/exec-broker/", "src/read-only-", "src/policy", "src/governance", "src/rbac/"],
  },
};

function strings(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item.length > 0)
  ) {
    throw new Error("invalid protected path rule list");
  }
  return value as string[];
}

export function parseProtectedPathRules(json: string): ProtectedPathRules {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("invalid protected path rules");
  }
  const source = parsed as Record<string, unknown>;
  const rules = {} as ProtectedPathRules;
  for (const category of CLASSES) {
    const entry = source[category];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`missing protected path class ${category}`);
    }
    const values = entry as Record<string, unknown>;
    rules[category] = { exact: strings(values.exact), prefix: strings(values.prefix) };
  }
  return rules;
}

export function loadProtectedPathRules(root: string): ProtectedPathRules {
  const projectRules = join(root, ".github", "kit-protected-paths.json");
  const shippedRules = new URL("../.github/kit-protected-paths.json", import.meta.url);
  return parseProtectedPathRules(
    readFileSync(existsSync(projectRules) ? projectRules : shippedRules, "utf8"),
  );
}

/** Keep the old and new protections until the rule change is approved. */
export function unionProtectedPathRules(
  base: ProtectedPathRules,
  head: ProtectedPathRules | null,
): ProtectedPathRules {
  const rules = {} as ProtectedPathRules;
  for (const category of CLASSES) {
    rules[category] = {
      exact: [...new Set([...base[category].exact, ...(head?.[category].exact ?? [])])],
      prefix: [...new Set([...base[category].prefix, ...(head?.[category].prefix ?? [])])],
    };
  }
  return rules;
}

export function classifyProtectedPaths(
  paths: string[],
  rules: ProtectedPathRules,
): { path: string; classes: ProtectedClass[] }[] {
  const matched: { path: string; classes: ProtectedClass[] }[] = [];
  for (const path of paths) {
    const classes = CLASSES.filter((category) => {
      const rule = rules[category];
      return (
        (category === "github" && path === ".github/kit-protected-paths.json") ||
        rule.exact.includes(path) ||
        rule.prefix.some((prefix) => path.startsWith(prefix))
      );
    });
    if (classes.length > 0) matched.push({ path, classes });
  }
  return matched;
}
