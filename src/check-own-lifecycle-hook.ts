/**
 * A lifecycle script in the repository's own `package.json` that runs a hidden file.
 *
 * `preinstall`, `install`, `postinstall` and `prepare` run on every `npm install` in the checkout:
 * on each developer's machine and in CI. The "wfx" campaign of November 2026 used that from stolen
 * accounts: one commit added a hidden `.ci-xxxxxx.sh` and a `postinstall` entry that runs it, in
 * more than 800 repositories (kit-research `wfx-github-actions-campaign-vs-kit`, after Endor Labs
 * and SafeDep). kit's install gate is about dependencies' scripts; nothing reported the
 * repository's own.
 *
 * Reported: a lifecycle script whose command names a file whose own name starts with a dot
 * (`.ci-ab12cd.sh`, `./.setup.mjs`, `scripts/.run.sh`). Not reported: a script in a dot directory
 * with an ordinary name (`.husky/install.mjs`), a command with no file, and every other script
 * key. The rule is narrow on purpose: ordinary `postinstall` scripts are common and legitimate.
 * It reads the root `package.json` only, never runs anything, and cannot tell a planted file from
 * one a maintainer hid.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";

const LIFECYCLE = ["preinstall", "install", "postinstall", "prepare"];
const SCRIPT_FILE = /\.(m?js|cjs|ts|mts|sh|bash|zsh|py|rb|ps1|cmd|bat)$/i;

/** The hidden script files a command names: a path whose last segment starts with a dot. Pure. */
export function hiddenScriptFiles(command: string): string[] {
  return command
    .split(/[\s;&|()]+/)
    .map((w) => w.replace(/^["']|["']$/g, ""))
    .filter((w) => {
      const base = w.split(/[\\/]/).pop() ?? "";
      return base.startsWith(".") && base.length > 1 && base !== ".." && SCRIPT_FILE.test(base);
    });
}

/** `[script key, hidden file]` for each lifecycle script of a package.json text. Pure. */
export function ownLifecycleHiddenFiles(packageJson: string): [string, string][] {
  let scripts: unknown;
  try {
    scripts = (JSON.parse(packageJson) as { scripts?: unknown }).scripts;
  } catch {
    return [];
  }
  if (!scripts || typeof scripts !== "object") return [];
  const out: [string, string][] = [];
  for (const key of LIFECYCLE) {
    const command = (scripts as Record<string, unknown>)[key];
    if (typeof command !== "string") continue;
    for (const file of hiddenScriptFiles(command)) out.push([key, file]);
  }
  return out;
}

/** One warning per lifecycle script of the root package.json that runs a hidden file. */
export function checkOwnLifecycleHook(root: string): SecurityCheckResult[] {
  let text: string;
  try {
    text = readFileSync(join(root, "package.json"), "utf-8");
  } catch {
    return [];
  }
  return ownLifecycleHiddenFiles(text).map(([key, file]) => ({
    category: "supply-chain" as const,
    name: `package.json ${key} runs a hidden file (${file})`,
    status: "warn" as const,
    severity: "high" as const,
    detail: `the repository's own ${key} script runs ${file} on every npm install, on developers' machines and in CI`,
    suggestion: `check who added the ${key} entry and ${file} (git log -- package.json ${file}); if nobody on the team did, treat the machines that ran npm install as compromised`,
  }));
}
