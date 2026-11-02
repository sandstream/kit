/** Shared by the cli*.test.ts files: run the built CLI in a fixture directory. */
import { mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);

// Resolve CLI path relative to this compiled test file
export const CLI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the kit CLI in a given directory, capturing output and exit code.
 */
export async function runCli(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<CliResult> {
  // Commands such as `kit setup` install lifecycle hooks. Keep those writes in
  // the disposable fixture instead of touching the developer's real agent config.
  const agentStateDir = join(cwd, ".kit-test-agent-state");
  await mkdir(agentStateDir, { recursive: true });
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env: {
        ...process.env,
        // Disable governance to avoid budget state side-effects
        KIT_CLAUDE_SETTINGS: join(agentStateDir, "claude-settings.json"),
        KIT_CODEX_HOOKS: join(agentStateDir, "codex-hooks.json"),
        KIT_MEMORY_HOOK_MARKER: join(agentStateDir, "claude-marker"),
        KIT_CODEX_MEMORY_HOOK_MARKER: join(agentStateDir, "codex-marker"),
        KIT_MEMORY_DB: join(agentStateDir, "memory.db"),
        ...env,
      },
      timeout: 30_000,
    });
    return { exitCode: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

// Standard .gitignore content for temp dirs so the security check passes
export const GITIGNORE_CONTENT = `.env
.env.local
.env.*.local
.env.keys
`;
