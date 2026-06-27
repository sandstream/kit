import { access, constants } from "node:fs/promises";
import { resolve } from "node:path";
import { exec } from "./utils/exec.js";

export interface CloneOptions {
  /** Git repository URL */
  repoUrl: string;
  /** Directory to clone into (defaults to repo name from URL) */
  targetDir?: string;
  /** If true, skip running kit setup after cloning */
  noSetup?: boolean;
  /** Environment name to pass to kit setup */
  environment?: string;
  /** Working directory for git clone (defaults to cwd) */
  cwd?: string;
}

export interface CloneResult {
  success: boolean;
  clonedPath: string;
  haskitToml: boolean;
  setupSkipped: boolean;
  message: string;
}

/**
 * Clone a Git repository and optionally run kit setup.
 * This is a synchronous wrapper around git clone + directory structure check.
 * The calling code (cli.ts) is responsible for running kit setup.
 */
export async function cloneRepository(opts: CloneOptions): Promise<CloneResult> {
  const { repoUrl, noSetup = false, cwd = process.cwd() } = opts;

  // Derive target directory from repo URL if not provided
  // e.g., "https://github.com/user/my-repo.git" → "my-repo"
  // Split on BOTH separators ourselves rather than path.basename: a repo URL
  // always uses "/", but path.basename is platform-routed (win32 basename also
  // splits on "\\"), so deriving the name by hand keeps it identical on every
  // OS and independent of the local path flavour. #43.
  let targetDir = opts.targetDir;
  if (!targetDir) {
    const lastSegment =
      repoUrl
        .replace(/[/\\]+$/, "")
        .split(/[/\\]/)
        .pop() ?? repoUrl;
    targetDir = lastSegment.replace(/\.git$/, "");
  }

  const clonedPath = resolve(cwd, targetDir);

  // Refuse option-injection and arbitrary-command transports. git honors
  // `ext::`/`fd::` "URLs" that execute commands (RCE), and a leading-dash URL is
  // parsed as a git option. The `--` below stops positional-as-option; this guard
  // blocks the transports `--` can't.
  const lowered = repoUrl.trim().toLowerCase();
  if (repoUrl.trim().startsWith("-") || lowered.startsWith("ext::") || lowered.startsWith("fd::")) {
    return {
      success: false,
      clonedPath,
      haskitToml: false,
      setupSkipped: false,
      message: `Refused to clone: unsafe repository URL "${repoUrl}"`,
    };
  }

  try {
    // Run git clone — `--` stops a leading-dash URL being read as an option.
    await exec("git", ["clone", "--", repoUrl, clonedPath], { timeout: 60_000 });

    // Check for .kit.toml
    let haskitToml = false;
    try {
      await access(resolve(clonedPath, ".kit.toml"), constants.R_OK);
      haskitToml = true;
    } catch {
      // .kit.toml not found — that's okay
    }

    let message = `Cloned ${repoUrl} to ${clonedPath}`;
    if (haskitToml) {
      message += noSetup
        ? "\nkit config found but setup skipped per --no-setup"
        : "\nkit config found — ready to run setup";
    } else {
      message += "\nNo .kit.toml found in repository";
    }

    return {
      success: true,
      clonedPath,
      haskitToml,
      setupSkipped: noSetup,
      message,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      clonedPath,
      haskitToml: false,
      setupSkipped: false,
      message: `Failed to clone repository: ${message}`,
    };
  }
}
