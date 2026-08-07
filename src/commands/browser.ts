import { existsSync } from "node:fs";
import { loadConfig } from "../config.js";
import { KIT_FILE, resolveConfigPath } from "../cli-shared.js";
import { c } from "../utils/colors.js";
import { hasFlag } from "../utils/flags.js";
import {
  diagnoseBrowser,
  resolveBrowserCdpUrl,
  resultOk,
  type BrowserCheck,
  type BrowserDoctorResult,
  type BrowserVerdictStatus,
} from "../browser.js";

export async function cmdBrowser(): Promise<boolean> {
  const sub = process.argv[3];
  if (!sub || sub === "--help" || sub === "-h") {
    printUsage();
    return true;
  }

  if (!["doctor", "status", "cdp-url", "playwright-env"].includes(sub)) {
    console.error(`${c.red}usage: kit browser <doctor|status|cdp-url|playwright-env> [--json]${c.reset}`);
    return false;
  }

  const config = existsSync(resolveConfigPath()) ? await loadConfig(resolveConfigPath()) : undefined;
  const diagnosis = await diagnoseBrowser(config?.browser);
  const jsonMode = hasFlag(process.argv, "--json");

  if (sub === "doctor") {
    if (jsonMode) console.log(JSON.stringify(diagnosis, null, 2));
    else renderDoctor(diagnosis);
    return resultOk(diagnosis.status);
  }

  if (sub === "status") {
    if (jsonMode) console.log(JSON.stringify({ status: diagnosis.status, strategy: diagnosis.strategy }, null, 2));
    else renderStatus(diagnosis);
    return resultOk(diagnosis.status);
  }

  if (sub === "cdp-url") {
    const cdpUrl = diagnosis.cdp_url ?? (await resolveBrowserCdpUrl(config?.browser));
    if (jsonMode) console.log(JSON.stringify({ cdp_url: cdpUrl ?? null, strategy: diagnosis.strategy }, null, 2));
    else if (cdpUrl) console.log(cdpUrl);
    else renderCdpBlocker(diagnosis);
    return Boolean(cdpUrl);
  }

  const cdpUrl = diagnosis.cdp_url ?? (await resolveBrowserCdpUrl(config?.browser));
  const env = cdpUrl ? { ...diagnosis.env, KIT_BROWSER_CDP_URL: cdpUrl } : diagnosis.env;
  if (jsonMode) console.log(JSON.stringify(env, null, 2));
  else renderPlaywrightEnv(env);
  return resultOk(diagnosis.status);
}

function printUsage(): void {
  console.log(`${c.bold}kit browser${c.reset}`);
  console.log("");
  console.log(`  ${c.cyan}kit browser doctor [--json]${c.reset}          Diagnose browser-verification readiness`);
  console.log(`  ${c.cyan}kit browser status [--json]${c.reset}          One-line strategy/status summary`);
  console.log(`  ${c.cyan}kit browser cdp-url [--json]${c.reset}         Print detected Chrome DevTools URL`);
  console.log(`  ${c.cyan}kit browser playwright-env [--json]${c.reset}  Print shell exports for test runners`);
  console.log("");
  console.log(`${c.dim}Declare [browser] in ${KIT_FILE}; kit owns local browser diagnostics, not app start.${c.reset}`);
}

function renderDoctor(diagnosis: BrowserDoctorResult): void {
  console.log(`${c.bold}Browser verification${c.reset}`);
  console.log(`  status: ${formatStatus(diagnosis.status)}`);
  console.log(`  strategy: ${c.bold}${diagnosis.strategy}${c.reset}`);
  console.log("");
  console.log(`${c.bold}Checks${c.reset}`);
  for (const check of diagnosis.checks) {
    const extra = check.command ? ` ${c.dim}(${check.command})${c.reset}` : "";
    console.log(`  ${icon(check.status)} ${check.name}  ${c.dim}${check.detail}${c.reset}${extra}`);
  }
  if (diagnosis.actions.length > 0) {
    console.log("");
    console.log(`${c.bold}Actions${c.reset}`);
    for (const action of diagnosis.actions) {
      console.log(`  ${c.yellow}!${c.reset} ${action.label}  ${c.dim}${action.reason}${c.reset}`);
      console.log(`    ${c.bold}${action.command}${c.reset}`);
    }
  }
}

function renderStatus(diagnosis: BrowserDoctorResult): void {
  const blocker = firstCheck(diagnosis, "blocker") ?? firstCheck(diagnosis, "fail");
  if (blocker) {
    console.log(`${formatStatus(diagnosis.status)} ${diagnosis.strategy}: ${blocker.detail}`);
    return;
  }
  console.log(`${formatStatus(diagnosis.status)} ${diagnosis.strategy}`);
}

function renderCdpBlocker(diagnosis: BrowserDoctorResult): void {
  const action = diagnosis.actions.find((a) => a.label === "Start Chrome with CDP");
  if (action) {
    console.error(`${c.yellow}No CDP URL detected.${c.reset}`);
    console.error(`${c.dim}${action.reason}${c.reset}`);
    console.error(action.command);
    return;
  }
  console.error(`${c.yellow}No CDP URL selected by current strategy.${c.reset}`);
}

function renderPlaywrightEnv(env: BrowserDoctorResult["env"]): void {
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) console.log(`export ${key}=${shellQuote(value)}`);
  }
}

function firstCheck(diagnosis: BrowserDoctorResult, status: BrowserVerdictStatus): BrowserCheck | undefined {
  return diagnosis.checks.find((check) => check.status === status);
}

function icon(status: BrowserVerdictStatus): string {
  if (status === "pass") return `${c.green}✓${c.reset}`;
  if (status === "fail" || status === "blocker") return `${c.red}✗${c.reset}`;
  if (status === "skip") return `${c.dim}-${c.reset}`;
  return `${c.yellow}!${c.reset}`;
}

function formatStatus(status: BrowserVerdictStatus): string {
  if (status === "pass") return `${c.green}pass${c.reset}`;
  if (status === "fail" || status === "blocker") return `${c.red}${status}${c.reset}`;
  if (status === "skip") return `${c.dim}skip${c.reset}`;
  return `${c.yellow}warn${c.reset}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
