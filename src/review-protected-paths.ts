/** Review classes that require a person before merge. The rule file is protected too. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type ProtectedClass = "release" | "github" | "secrets" | "permissions";
type Patterns = { exact: string[]; prefix: string[] };
export type ProtectedPathRules = Record<ProtectedClass, Patterns>;

const CLASSES: readonly ProtectedClass[] = ["release", "github", "secrets", "permissions"];

function strings(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item.length > 0)
  ) {
    throw new Error("invalid protected path rule list");
  }
  return value as string[];
}

export function loadProtectedPathRules(root: string): ProtectedPathRules {
  const parsed: unknown = JSON.parse(
    readFileSync(join(root, ".github", "kit-protected-paths.json"), "utf8"),
  );
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

export function classifyProtectedPaths(
  paths: string[],
  rules: ProtectedPathRules,
): { path: string; classes: ProtectedClass[] }[] {
  const matched: { path: string; classes: ProtectedClass[] }[] = [];
  for (const path of paths) {
    const classes = CLASSES.filter((category) => {
      const rule = rules[category];
      return rule.exact.includes(path) || rule.prefix.some((prefix) => path.startsWith(prefix));
    });
    if (classes.length > 0) matched.push({ path, classes });
  }
  return matched;
}
