/**
 * `kit init` needs a git repository: the hooks, the secret scan of staged files and the
 * repo-scoped memory all assume one. Without it init used to finish with a half-installed
 * result and no hint why. This step makes sure a repo exists before anything else runs.
 *
 * A directory inside an existing work tree counts as present, so a monorepo package never
 * gets a nested repository of its own.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { c } from "../utils/colors.js";
import { promptConfirm } from "../utils/prompt.js";

const run = promisify(execFile);

export type EnsureGitResult = "present" | "initialized" | "declined";

export interface EnsureGitOptions {
  cwd: string;
  /** True when nobody can be asked (flag, CI or no TTY): init without a question. */
  nonInteractive: boolean;
  confirm: (prompt: string) => Promise<boolean>;
}

async function insideWorkTree(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

export async function ensureGitRepo(options: EnsureGitOptions): Promise<EnsureGitResult> {
  if (await insideWorkTree(options.cwd)) return "present";
  if (!options.nonInteractive) {
    const accepted = await options.confirm("No git repository here. Run git init? [Y/n] ");
    if (!accepted) return "declined";
  }
  await run("git", ["init", "-q"], { cwd: options.cwd });
  return "initialized";
}

/** The `kit init` step: make sure a repo exists and say what happened. */
export async function initGitStep(nonInteractive: boolean): Promise<void> {
  const state = await ensureGitRepo({
    cwd: process.cwd(),
    nonInteractive,
    confirm: (prompt) => promptConfirm(prompt),
  });
  if (state === "initialized") {
    console.log(`  ${c.green}✓${c.reset} Initialized a git repository\n`);
  } else if (state === "declined") {
    console.log(
      `${c.yellow}No git repository: hooks and the staged-file secret scan stay off until you run git init.${c.reset}\n`,
    );
  }
}
