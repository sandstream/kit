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
    | "failed";
  detail: string;
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
        detail: status.output,
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
          detail: verify.output,
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
