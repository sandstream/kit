import { writeFile, chmod, mkdir } from "node:fs/promises";
import { resolve, isAbsolute, dirname } from "node:path";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { HooksConfig } from "./config.js";

/**
 * The directory git ACTUALLY runs hooks from. When `core.hooksPath` is set
 * (husky, lefthook, a committed `.githooks/`), git ignores `.git/hooks`
 * entirely — installing there is a silent no-op, so a security gate like
 * `context-check` would report installed but never run. Honor hooksPath so an
 * installed hook actually fires.
 *
 * Detection is scoped to the target repo (the parent of `gitDir`), not the
 * process cwd, so temp-dir tests that pass an absolute throwaway gitDir fall
 * back to `<gitDir>/hooks` even when the kit repo itself sets hooksPath.
 */
export function resolveHooksDir(gitDir = ".git"): string {
  const repoRoot = isAbsolute(gitDir) ? dirname(gitDir) : process.cwd();
  try {
    const hp = execFileSync("git", ["-C", repoRoot, "config", "--get", "core.hooksPath"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (hp) return isAbsolute(hp) ? hp : resolve(repoRoot, hp);
  } catch {
    /* not a git repo, hooksPath unset, or git absent — fall back below */
  }
  return resolve(process.cwd(), gitDir, "hooks");
}

/**
 * Path (relative to .git) of the sentinel file written by the kit
 * pre-commit hook. The post-commit detector reads it back; if it's missing
 * the commit was made with `--no-verify` and we audit the skip.
 */
export const HOOK_SENTINEL_REL = ".kit-hook-ran";

/**
 * Project-relative log of commits that bypassed pre-commit. Written by the
 * post-commit hook; read once per `kit` invocation to surface a banner.
 */
export const SKIPPED_COMMITS_LOG = ".kit-skipped-commits.jsonl";

export interface HookInstallResult {
  hookName: string;
  action: "installed" | "updated" | "skipped" | "failed";
  detail: string;
}

/**
 * Install git hooks from configuration
 */
export async function installHooks(
  config: HooksConfig,
  gitDir = ".git",
): Promise<HookInstallResult[]> {
  // Read-only mode: hooks are writes to .git/hooks/. Refuse + audit.
  const { isReadOnlyMode, refuseWrite } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) {
    const refusal = await refuseWrite("install-hooks", {
      hook_count: Object.keys(config).length,
    });
    return [{ hookName: "read-only-refusal", action: "failed", detail: refusal.reason }];
  }
  const results: HookInstallResult[] = [];
  const hooksDir = resolveHooksDir(gitDir);

  // Ensure hooks directory exists
  try {
    await mkdir(hooksDir, { recursive: true });
  } catch (error) {
    return [
      {
        hookName: "hooks-dir",
        action: "failed",
        detail: `Failed to create hooks directory: ${error}`,
      },
    ];
  }

  // Install each hook
  for (const [hookName, commands] of Object.entries(config)) {
    if (!commands || commands.length === 0) {
      continue;
    }

    const result = await installHook(hooksDir, hookName, commands);
    results.push(result);
  }

  // Always install the bypass detector — independent of HooksConfig so the
  // user can't omit it. Even repos that don't configure any other hooks get
  // the sentinel pair so `--no-verify` is detectable post-facto.
  const detectorResults = await installBypassDetector(hooksDir);
  results.push(...detectorResults);

  return results;
}

/**
 * Writes (or re-writes) the pre-commit sentinel-writer and the post-commit
 * detector. The pair makes `git commit --no-verify` non-silent: the
 * post-commit hook compares the sentinel to HEAD and logs a skip event
 * when they don't match (or the sentinel is missing entirely).
 *
 * Git doesn't expose `--no-verify` to hooks, so we can't prevent the skip
 * — but we can guarantee a forensic trail and a stderr banner on the next
 * `kit` command in the repo.
 */
async function installBypassDetector(
  hooksDir: string,
): Promise<HookInstallResult[]> {
  const results: HookInstallResult[] = [];

  const preCommitDetectorPath = resolve(hooksDir, "pre-commit");
  const postCommitDetectorPath = resolve(hooksDir, "post-commit");

  // The pre-commit sentinel WRITER must run even when the user has no
  // other pre-commit steps configured. If a real pre-commit script
  // already exists (from installHook above), prepend the sentinel write.
  try {
    const sentinelWriter = sentinelWriterScript();
    if (existsSync(preCommitDetectorPath)) {
      const { readFile } = await import("node:fs/promises");
      const current = await readFile(preCommitDetectorPath, "utf-8");
      if (!current.includes("KIT_HOOK_SENTINEL")) {
        // Inject the sentinel-write block right after the shebang line.
        const lines = current.split("\n");
        const injected = [lines[0], "", sentinelWriter, ...lines.slice(1)].join("\n");
        await writeFile(preCommitDetectorPath, injected, "utf-8");
        await chmod(preCommitDetectorPath, 0o755);
      }
    } else {
      await writeFile(
        preCommitDetectorPath,
        `#!/bin/sh\n${sentinelWriter}\nexit 0\n`,
        "utf-8",
      );
      await chmod(preCommitDetectorPath, 0o755);
    }
    results.push({
      hookName: "pre-commit (sentinel)",
      action: "installed",
      detail: "writes .git/.kit-hook-ran on every pre-commit pass",
    });
  } catch (error) {
    results.push({
      hookName: "pre-commit (sentinel)",
      action: "failed",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const detectorScript = postCommitDetectorScript();
    if (existsSync(postCommitDetectorPath)) {
      const { readFile } = await import("node:fs/promises");
      const current = await readFile(postCommitDetectorPath, "utf-8");
      if (!current.includes("KIT_HOOK_SENTINEL")) {
        const lines = current.split("\n");
        const injected = [lines[0], "", detectorScript, ...lines.slice(1)].join("\n");
        await writeFile(postCommitDetectorPath, injected, "utf-8");
        await chmod(postCommitDetectorPath, 0o755);
      }
    } else {
      await writeFile(
        postCommitDetectorPath,
        `#!/bin/sh\n${detectorScript}\nexit 0\n`,
        "utf-8",
      );
      await chmod(postCommitDetectorPath, 0o755);
    }
    results.push({
      hookName: "post-commit (bypass-detector)",
      action: "installed",
      detail: "logs commits whose pre-commit hook didn't run",
    });
  } catch (error) {
    results.push({
      hookName: "post-commit (bypass-detector)",
      action: "failed",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  return results;
}

function sentinelWriterScript(): string {
  return `# KIT_HOOK_SENTINEL: record that pre-commit actually ran. The
# post-commit detector compares the sentinel to HEAD; mismatch or absence
# means \`git commit --no-verify\` skipped the gate.
__kit_git_dir=\${GIT_DIR:-$(git rev-parse --git-dir 2>/dev/null)}
if [ -n "$__kit_git_dir" ]; then
  date -u +"%Y-%m-%dT%H:%M:%SZ" > "$__kit_git_dir/${HOOK_SENTINEL_REL}" 2>/dev/null || true
fi`;
}

function postCommitDetectorScript(): string {
  return `# KIT_HOOK_SENTINEL: detect --no-verify skips. If the sentinel
# is missing OR older than the commit (i.e. wasn't written by this commit's
# pre-commit pass), record a skip event so the operator and CI can see it.
__kit_git_dir=\${GIT_DIR:-$(git rev-parse --git-dir 2>/dev/null)}
__kit_repo_root=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$__kit_git_dir" ] && [ -n "$__kit_repo_root" ]; then
  __kit_sentinel="$__kit_git_dir/${HOOK_SENTINEL_REL}"
  __kit_head=$(git rev-parse HEAD 2>/dev/null)
  if [ ! -f "$__kit_sentinel" ]; then
    __kit_reason="sentinel-missing"
  else
    # If the sentinel timestamp pre-dates the commit author time by more
    # than ~5min, treat as stale (left from an earlier run).
    __kit_sentinel_ts=$(stat -c %Y "$__kit_sentinel" 2>/dev/null || stat -f %m "$__kit_sentinel" 2>/dev/null)
    __kit_commit_ts=$(git log -1 --format=%ct HEAD 2>/dev/null)
    if [ -n "$__kit_sentinel_ts" ] && [ -n "$__kit_commit_ts" ]; then
      __kit_delta=$(( __kit_commit_ts - __kit_sentinel_ts ))
      if [ "$__kit_delta" -gt 300 ] || [ "$__kit_delta" -lt -300 ]; then
        __kit_reason="sentinel-stale"
      fi
    fi
  fi
  if [ -n "$__kit_reason" ]; then
    __kit_log="$__kit_repo_root/${SKIPPED_COMMITS_LOG}"
    __kit_ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    printf '{"timestamp":"%s","sha":"%s","reason":"%s","user":"%s"}\\n' \\
      "$__kit_ts" "$__kit_head" "$__kit_reason" "\${USER:-unknown}" \\
      >> "$__kit_log" 2>/dev/null || true
    echo "[kit] WARNING: pre-commit hook was skipped ($__kit_reason). Logged to ${SKIPPED_COMMITS_LOG}." >&2
  fi
  # Clean up sentinel so the next commit starts fresh.
  rm -f "$__kit_sentinel" 2>/dev/null || true
fi`;
}

/**
 * Install a single git hook
 */
async function installHook(
  hooksDir: string,
  hookName: string,
  commands: string[],
): Promise<HookInstallResult> {
  const hookPath = resolve(hooksDir, hookName);
  const hookContent = generateHookScript(hookName, commands);

  try {
    // Check if hook already exists
    const exists = existsSync(hookPath);

    // Never overwrite a hook kit did not generate (e.g. a committed
    // .githooks/pre-push). Clobbering the operator's own gate would silently
    // drop whatever it enforced. Skip and tell them to merge or remove it.
    if (exists) {
      const { readFile } = await import("node:fs/promises");
      const current = await readFile(hookPath, "utf-8").catch(() => "");
      if (current && !current.includes("Generated by kit")) {
        return {
          hookName,
          action: "skipped",
          detail: `existing non-kit ${hookName} at ${hookPath} — left untouched; add \`${commands.join(" && ")}\` to it manually or remove it, then re-run`,
        };
      }
    }
    const action = exists ? "updated" : "installed";

    // Write hook file
    await writeFile(hookPath, hookContent, "utf-8");

    // Make executable
    await chmod(hookPath, 0o755);

    return {
      hookName,
      action,
      detail: `${commands.length} command(s)`,
    };
  } catch (error) {
    return {
      hookName,
      action: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Generate hook script content
 */
function generateHookScript(hookName: string, commands: string[]): string {
  const total = commands.length;

  // Each command is framed as a numbered step with live ▶ / ✓ / ✗ markers and
  // a per-step duration, mirroring the runStep() util used by the CLI
  // (src/output.ts). The raw command text is echoed and executed verbatim so
  // check-hooks' `content.includes(cmd)` up-to-date detection keeps working.
  const steps = commands
    .map((cmd, index) => {
      const n = index + 1;
      return `
__s=$(date +%s)
echo "▶ [${n}/${total}] ${cmd}"
if ${cmd}; then
  echo "✓ [${n}/${total}] ${cmd}  ($(( $(date +%s) - __s ))s)"
else
  echo "✗ ${hookName} step ${n}/${total} failed: ${cmd}"
  exit 1
fi`;
    })
    .join("\n");

  return `#!/bin/sh
# Generated by kit
# Hook: ${hookName}
# Commands: ${total}

set -e

__t0=$(date +%s)
echo "🔍 ${hookName} — running ${total} step(s)…"
${steps}

echo "✅ ${hookName} passed — ${total} step(s) in $(( $(date +%s) - __t0 ))s"
exit 0
`;
}

/**
 * Uninstall git hooks
 */
export async function uninstallHooks(
  hookNames: string[],
  gitDir = ".git",
): Promise<HookInstallResult[]> {
  const results: HookInstallResult[] = [];
  const hooksDir = resolveHooksDir(gitDir);

  for (const hookName of hookNames) {
    const hookPath = resolve(hooksDir, hookName);

    try {
      if (existsSync(hookPath)) {
        const { unlink } = await import("node:fs/promises");
        await unlink(hookPath);
        results.push({
          hookName,
          action: "installed", // Using "installed" to mean "removed"
          detail: "uninstalled",
        });
      } else {
        results.push({
          hookName,
          action: "skipped",
          detail: "not found",
        });
      }
    } catch (error) {
      results.push({
        hookName,
        action: "failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}
