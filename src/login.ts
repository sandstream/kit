import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { ServiceConfig } from "./config.js";
import { checkServices, type ServiceStatus } from "./check-services.js";
import { isNonInteractive } from "./environment.js";
import { parseCommand } from "./utils/parseCommand.js";

const exec = promisify(execFile);

export interface LoginResult {
  name: string;
  action:
    | "already_authenticated"
    | "logged_in"
    | "login_unverified"
    | "manual"
    | "failed";
  detail: string;
}

/**
 * Mask secret-looking tokens in a string before it is shown to the user. Auth
 * "check" commands sometimes echo credentials — e.g. `stripe config --list`
 * prints `test_mode_api_key = 'sk_test_…'` — and that output must never reach
 * the terminal verbatim. Conservative: masks known key/token shapes (Stripe,
 * GitHub, Slack, AWS, JWTs) and any `key = value` assignment, keeping the
 * surrounding context. PURE so it can be unit-tested.
 */
export function redactSecrets(s: string): string {
  return s
    .replace(/\b((?:sk|rk|pk|whsec)_(?:live_|test_)?)[A-Za-z0-9]{6,}/g, "$1…")
    .replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{6,}/g, "$1…")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{6,}/g, "xox…")
    .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, "eyJ…")
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{12,}/g, "$1…")
    .replace(
      /\b(api[_-]?key|secret|token|password|pub_key|pwd|auth)\b(\s*[:=]\s*)\S+/gi,
      "$1$2…",
    );
}

/**
 * Turn an auth-check command's raw output into a single, secret-free status
 * line safe to display (the account identity is whatever the tool prints on
 * its first non-empty line — "Logged in as octocat", "sandstream"). Multi-line
 * config dumps collapse to one line; secret-looking tokens are masked.
 */
export function safeStatusDetail(output: string): string {
  const line =
    (output || "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  return redactSecrets(line).slice(0, 80);
}

function runInteractive(command: string): Promise<{ ok: boolean; detail: string }> {
  const parsed = parseCommand(command);
  if (parsed.kind === "informational") {
    if (!isNonInteractive()) {
      console.log(`\x1b[33m${parsed.message}\x1b[0m`);
    }
    return Promise.resolve({
      ok: false,
      detail: `manual setup required: ${parsed.message}`,
    });
  }

  if (isNonInteractive()) {
    return Promise.resolve({
      ok: false,
      detail: "skipped in non-interactive mode",
    });
  }

  return new Promise((resolve) => {
    const child = spawn(parsed.cmd, parsed.args, {
      stdio: "inherit",
      env: { ...process.env },
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, detail: "Login completed" });
      } else {
        resolve({ ok: false, detail: `Login exited with code ${code}` });
      }
    });

    child.on("error", (err) => {
      resolve({ ok: false, detail: err.message });
    });
  });
}

async function runQuiet(command: string): Promise<{ ok: boolean; output: string }> {
  const parsed = parseCommand(command);
  if (parsed.kind === "informational") {
    return { ok: false, output: parsed.message };
  }
  try {
    const { stdout, stderr } = await exec(parsed.cmd, parsed.args, {
      timeout: 15_000,
      env: { ...process.env },
    });
    return { ok: true, output: (stdout || stderr).trim() };
  } catch {
    return { ok: false, output: "Command failed" };
  }
}

export interface LoginDeps {
  checkServices: (services: Record<string, ServiceConfig>) => Promise<ServiceStatus[]>;
  runLogin: (command: string) => Promise<{ ok: boolean; detail: string }>;
  runLink: (command: string) => Promise<{ ok: boolean; detail: string }>;
  runVerify: (command: string) => Promise<{ ok: boolean; output: string }>;
}

const defaultDeps: LoginDeps = {
  checkServices,
  runLogin: runInteractive,
  runLink: runInteractive,
  runVerify: runQuiet,
};

export async function loginServices(
  services: Record<string, ServiceConfig>,
  deps: LoginDeps = defaultDeps,
): Promise<LoginResult[]> {
  const statuses = await deps.checkServices(services);
  const results: LoginResult[] = [];

  for (const status of statuses) {
    if (status.authenticated) {
      results.push({
        name: status.name,
        action: "already_authenticated",
        detail: safeStatusDetail(status.output),
      });
      continue;
    }

    const config = services[status.name];
    if (!config?.login) {
      results.push({
        name: status.name,
        action: "failed",
        detail: "No login command configured",
      });
      continue;
    }

    // A service whose "login" is informational (no CLI login — set an env var,
    // paste a DSN) is expected manual setup, not a failure. Surface it as
    // "manual" so it doesn't fail the step or get pointlessly retried.
    const parsedLogin = parseCommand(config.login);
    if (parsedLogin.kind === "informational") {
      results.push({
        name: status.name,
        action: "manual",
        detail: parsedLogin.message,
      });
      continue;
    }

    console.log(`\n\x1b[1mLogging in to ${status.name}...\x1b[0m`);
    const login = await deps.runLogin(config.login);

    if (!login.ok) {
      results.push({ name: status.name, action: "failed", detail: login.detail });
      continue;
    }

    // Run link command if configured (e.g. supabase link, vercel link)
    if (config.link) {
      console.log(`\x1b[2mLinking ${status.name}...\x1b[0m`);
      const link = await deps.runLink(config.link);
      if (!link.ok) {
        results.push({
          name: status.name,
          action: "login_unverified",
          detail: `Login OK but link failed: ${link.detail}`,
        });
        continue;
      }
    }

    // Verify login by re-running check
    if (config.check) {
      const verify = await deps.runVerify(config.check);
      if (verify.ok) {
        results.push({
          name: status.name,
          action: "logged_in",
          detail: safeStatusDetail(verify.output),
        });
      } else {
        results.push({
          name: status.name,
          action: "login_unverified",
          detail: "Login command succeeded but verification failed",
        });
      }
    } else {
      results.push({
        name: status.name,
        action: "logged_in",
        detail: login.detail,
      });
    }
  }

  return results;
}
