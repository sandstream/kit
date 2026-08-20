/**
 * `kit upgrade` command + self-upgrade helpers — extracted from cli.ts
 * (5.0-alpha god-module split).
 *
 * `cmdUpgrade` is the top-level entry (COMMANDS dispatch table). `selfUpgrade`
 * is also invoked from cli.ts's default auto-update flow, and the two npm-error
 * helpers are re-exported from cli.ts for upgrade-self-error.test.ts — so all
 * four are exported. Imports only sibling core modules, never cli.ts.
 */
import { c } from "../utils/colors.js";
import { hasFlag, unknownFlags, GLOBAL_FLAGS } from "../utils/flags.js";
import { loadConfig } from "../config.js";
import { resolveConfigPath } from "../cli-shared.js";
import { readkitMeta, updateSkillsLock, updateCliLock } from "../lock.js";

/**
 * Detect the npm global-install permission failure (EACCES / EPERM writing into
 * a root-owned prefix). This is the #1 cause of `npm i -g` failures and the raw
 * "Command failed" message gives no hint, so we sniff the combined message +
 * stderr for the well-known signatures.
 */
export function isNpmPermissionError(text: string): boolean {
  return /\bEACCES\b|\bEPERM\b|permission denied|operation not permitted|EACCES: permission/i.test(
    text,
  );
}

/**
 * The documented remediation for an `npm -g` EACCES: switch to a user-owned
 * prefix instead of `sudo` (sudo-installed globals leave root-owned files that
 * break every later install). Returns ready-to-print lines.
 */
export function npmPermissionRemediation(): string[] {
  return [
    `${c.yellow}This is an npm permission error (EACCES) — npm cannot write to its global prefix.${c.reset}`,
    `${c.dim}Do NOT use sudo. Point npm at a user-owned prefix, then re-run the upgrade:${c.reset}`,
    `  ${c.bold}npm config set prefix ~/.npm-global${c.reset}`,
    `  ${c.bold}export PATH=~/.npm-global/bin:$PATH${c.reset}  ${c.dim}# add to your ~/.zshrc or ~/.bashrc${c.reset}`,
    `  ${c.bold}kit upgrade --self${c.reset}`,
  ];
}

/**
 * Governed self-upgrade: kit triages its OWN npm package before installing a new
 * version of itself. WATERTIGHT — an untriaged kit is never installed; offline /
 * triage-unavailable → blocked (fail-closed). The raw `npm i -g sandstream-kit`
 * is still available to the user, but that path is outside kit's governance.
 */
export async function selfUpgrade(): Promise<boolean> {
  const { gateInstall } = await import("../triage-gate.js");
  console.log(`${c.dim}Triaging sandstream-kit before upgrading itself…${c.reset}`);
  const verdict = await gateInstall("npm:sandstream-kit");
  if (verdict.decision === "blocked") {
    console.error(`${c.red}✗ self-upgrade blocked: ${verdict.reason}${c.reset}`);
    console.error(
      `${c.dim}kit will not install an untriaged version of itself. Get online with the triage skill installed, then retry.${c.reset}`,
    );
    return false;
  }
  console.log(`${c.green}✓${c.reset} ${verdict.reason} — upgrading…\n`);
  try {
    const { exec } = await import("../utils/exec.js");
    await exec("npm", ["install", "-g", "sandstream-kit@latest"], {
      timeout: 180_000,
      env: { ...process.env },
    });
    console.log(
      `\n${c.green}${c.bold}✓ kit upgraded${c.reset} — run ${c.bold}kit --version${c.reset} to confirm.`,
    );
    // The RUNNING process is still the old version — without this, the exit
    // banner would announce "Update available: old → new" right after a
    // successful upgrade, reading as "the upgrade didn't take".
    const { suppressUpdateNotice } = await import("../update-check.js");
    suppressUpdateNotice();
    return true;
  } catch (err: unknown) {
    const { redactSecrets } = await import("../utils/redactSecrets.js");
    const msg = err instanceof Error ? err.message : String(err);
    // promisified execFile attaches the child's stderr to the error object
    const stderr =
      typeof (err as { stderr?: unknown })?.stderr === "string"
        ? (err as { stderr: string }).stderr
        : "";
    const combined = `${msg}\n${stderr}`;
    console.error(`${c.red}✗ npm install failed: ${redactSecrets(msg.split("\n")[0])}${c.reset}`);
    if (stderr.trim()) {
      console.error(`${c.dim}${redactSecrets(stderr.trim())}${c.reset}`);
    }
    if (isNpmPermissionError(combined)) {
      console.error();
      for (const line of npmPermissionRemediation()) console.error(line);
    } else {
      console.error(
        `${c.dim}If this persists, install manually: ${c.reset}${c.bold}npm install -g sandstream-kit@latest${c.reset}`,
      );
    }
    return false;
  }
}

/**
 * Every flag `kit upgrade` honors. `--self` is the only one the command reads;
 * the globals are honored by cli.ts / config.ts for every command.
 */
export const UPGRADE_FLAGS = ["--self", ...GLOBAL_FLAGS] as const;

export async function cmdUpgrade(): Promise<boolean> {
  console.log(`${c.bold}${c.cyan}kit upgrade${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  // A typo'd flag must not silently become a DIFFERENT operation. `kit upgrade
  // --self.` (trailing period) missed the exact-match in hasFlag, fell through
  // to the lock-file path, and rewrote every `installedAt` in .kit/cli-lock.json
  // to "now" while installing nothing — reported as a successful upgrade.
  const bad = unknownFlags(process.argv, UPGRADE_FLAGS);
  if (bad.length > 0) {
    const plural = bad.length > 1 ? "s" : "";
    console.error(`${c.red}unknown flag${plural} for kit upgrade: ${bad.join(", ")}${c.reset}`);
    console.error(`${c.dim}accepted: ${UPGRADE_FLAGS.join(" ")}${c.reset}`);
    return false;
  }

  if (hasFlag(process.argv, "--self")) {
    return await selfUpgrade();
  }

  const config = await loadConfig(resolveConfigPath());

  // Update skills lock
  const skills: Record<string, string> = {};
  if (config.skills?.required) {
    Object.assign(skills, config.skills.required);
  }
  if (config.skills?.optional) {
    Object.assign(skills, config.skills.optional);
  }

  const kitMeta = await readkitMeta();
  await updateSkillsLock(skills, kitMeta?.name ? `${kitMeta.name}@${kitMeta.version}` : undefined);

  // Update CLI lock
  const tools: Record<
    string,
    { version: string; source: "mise" | "npm" | "pip" | "manual"; auth?: string }
  > = {};
  if (config.tools) {
    for (const [name, version] of Object.entries(config.tools)) {
      tools[name] = { version, source: "mise" };
    }
  }

  await updateCliLock(tools);

  console.log(`${c.green}✓${c.reset} Updated lock files from .kit.toml\n`);

  console.log(
    `${c.dim}Run ${c.reset}${c.bold}kit install${c.reset}${c.dim} to install updated tools${c.reset}`,
  );
  console.log(
    `${c.dim}Run ${c.reset}${c.bold}kit skills${c.reset}${c.dim} to check skill status${c.reset}\n`,
  );

  return true;
}
