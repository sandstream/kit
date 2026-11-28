/**
 * Aider commits with `git commit --no-verify` unless `git-commit-verify` is on, so kit's git
 * hooks (pre-commit secret scan, commit gates) never run on Aider's commits.
 *
 * Evidence (Aider-AI/aider at 5dc9490bb35f9729ef2c95d00a19ccd30c26339c):
 *   - `--git-commit-verify` defaults to False (`aider/args.py:491-496`).
 *   - `aider/repo.py:278-279` appends `--no-verify` when it is false.
 *   - Config files: `.aider.conf.yml` in the cwd, the git root and the home directory, in that
 *     priority (`aider/main.py:464-477`), and `AIDER_*` environment variables
 *     (`auto_env_var_prefix="AIDER_"`, `aider/args.py:41`), which configargparse ranks above files.
 *
 * Read-only. A line-level read of the one key, not a YAML parser: `git-commit-verify: true`
 * (YAML 1.1 booleans, as PyYAML reads them).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";

/** Files that mark a repository Aider works in (same markers `installAiderRules` uses). */
const AIDER_MARKERS = [".aider.conf.yml", ".aider.chat.history.md", ".aider.input.history"];

/** PyYAML's YAML 1.1 booleans. Pure. */
function yamlBool(raw: string): boolean | undefined {
  const v = raw
    .replace(/\s+#.*$/, "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .toLowerCase();
  if (["true", "yes", "on", "y"].includes(v)) return true;
  if (["false", "no", "off", "n"].includes(v)) return false;
  return undefined;
}

/** The `git-commit-verify` value a `.aider.conf.yml` sets, or undefined. Pure. */
export function aiderCommitVerify(confYml: string): boolean | undefined {
  let value: boolean | undefined;
  for (const line of confYml.split(/\r?\n/)) {
    const m = /^git-commit-verify\s*:\s*(.*)$/.exec(line);
    if (m) value = yamlBool(m[1]);
  }
  return value;
}

function readConf(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/** The effective setting: env first, then repo `.aider.conf.yml`, then the home one. */
function effectiveAiderCommitVerify(
  root: string,
  home: string,
  env: Record<string, unknown>,
): { value: boolean; source: string } {
  const fromEnv = env.AIDER_GIT_COMMIT_VERIFY;
  if (typeof fromEnv === "string") {
    const v = yamlBool(fromEnv);
    if (v !== undefined) return { value: v, source: "AIDER_GIT_COMMIT_VERIFY" };
  }
  for (const [file, shown] of [
    [join(root, ".aider.conf.yml"), ".aider.conf.yml"],
    [join(home, ".aider.conf.yml"), "~/.aider.conf.yml"],
  ] as const) {
    const body = readConf(file);
    const v = body === null ? undefined : aiderCommitVerify(body);
    if (v !== undefined) return { value: v, source: shown };
  }
  return { value: false, source: "Aider's default" };
}

/** `kit check` row: warn when Aider works in this repository and commits with --no-verify. */
export function checkAiderCommitVerify(
  root: string,
  home: string,
  env: Record<string, unknown> = process.env,
): SecurityCheckResult[] {
  if (!AIDER_MARKERS.some((f) => existsSync(join(root, f)))) return [];
  const { value, source } = effectiveAiderCommitVerify(root, home, env);
  if (value) {
    return [
      {
        category: "exposure",
        name: "aider git hooks",
        status: "pass",
        detail: `Aider runs git hooks on its commits (git-commit-verify: true, from ${source})`,
      },
    ];
  }
  return [
    {
      category: "exposure",
      name: "aider git hooks",
      status: "warn",
      severity: "medium",
      detail: `Aider commits with --no-verify (${source}), so kit's git hooks do not run on Aider's commits`,
      suggestion:
        "add `git-commit-verify: true` to .aider.conf.yml, so Aider's commits go through the pre-commit hooks",
    },
  ];
}
