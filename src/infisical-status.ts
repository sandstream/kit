import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { exec } from "./utils/exec.js";
import { resolveToolBin } from "./utils/resolveTool.js";

const STATUS_ARGS = ["login", "status", "--json", "--silent", "--telemetry=false"];
const KEYRING = "infisical login (keyring)";
const ENVIRONMENT = "INFISICAL_TOKEN environment variable";
const FLAG = "--token flag";

interface InfisicalStatus {
  ok: boolean;
  output: string;
}

interface Session {
  tokenSource: string;
  domain: string;
  status?: unknown;
  verification?: { state?: unknown };
}

type ParsedSessions = { sessions: Session[] } | { failure: InfisicalStatus };
type SelectedSession = { active: Session } | { failure: InfisicalStatus };

function unverified(reason: string): InfisicalStatus {
  return { ok: false, output: `Infisical authentication not verified: ${reason}` };
}

export function isInfisicalLoginStatus(args: string[]): boolean {
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (["--domain", "--log-level", "-l", "--token"].includes(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    words.push(arg);
    if (words.length === 2) return words[0] === "login" && words[1] === "status";
  }
  return false;
}

function normalizedDomain(value: string): string {
  const url = new URL(value.trim());
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Invalid Infisical domain");
  }
  return url.origin + url.pathname.replace(/\/+$/, "").replace(/\/api$/, "");
}

function domainFlag(args: string[]): string | undefined {
  let flag: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") break;
    if (args[i] === "--domain") flag = args[++i] ?? "";
    else if (args[i].startsWith("--domain=")) flag = args[i].slice("--domain=".length);
  }
  return flag;
}

function workspaceDomainBinding(workspace: unknown): string | undefined {
  if (typeof workspace !== "object" || workspace === null || Array.isArray(workspace))
    throw new Error("Invalid workspace binding");
  if ("domain" in workspace) {
    if (typeof workspace.domain === "string" && workspace.domain)
      return normalizedDomain(workspace.domain);
    if (workspace.domain != null && workspace.domain !== "") throw new Error("Invalid domain");
  }
  return undefined;
}

async function workspaceDomain(cwd: string): Promise<string | undefined> {
  // Match the CLI's nearest-parent workspace lookup, without opening its private
  // credential store. An unreadable/malformed binding cannot establish scope.
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    try {
      const workspace: unknown = JSON.parse(await readFile(join(dir, ".infisical.json"), "utf8"));
      return workspaceDomainBinding(workspace);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (dir === dirname(dir)) return undefined;
  }
}

async function configuredDomain(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<string | undefined> {
  const flag = domainFlag(args);
  if (flag !== undefined) return normalizedDomain(flag);
  for (const name of ["INFISICAL_DOMAIN", "INFISICAL_API_URL"]) {
    if (env[name]?.trim()) return normalizedDomain(env[name]!);
  }
  return workspaceDomain(cwd);
}

function isSession(value: unknown): value is Session {
  return (
    typeof value === "object" &&
    value !== null &&
    "tokenSource" in value &&
    typeof value.tokenSource === "string" &&
    "domain" in value &&
    typeof value.domain === "string" &&
    (!("verification" in value) ||
      (typeof value.verification === "object" && value.verification !== null))
  );
}

function parseSessions(stdout: string): ParsedSessions {
  try {
    const data: unknown = JSON.parse(stdout);
    if (
      typeof data !== "object" ||
      data === null ||
      !("sessions" in data) ||
      !Array.isArray(data.sessions)
    )
      throw new Error("Invalid status");
    if (!data.sessions.every(isSession))
      return { failure: unverified("session source/domain metadata missing or ambiguous.") };
    return { sessions: data.sessions };
  } catch {
    return {
      failure: unverified("expected status JSON from `infisical login status --json --silent`."),
    };
  }
}

function ambiguousSources(sources: string[], flagToken: boolean): boolean {
  return (
    new Set(sources).size !== sources.length ||
    sources.some((source) => ![KEYRING, ENVIRONMENT, FLAG].includes(source)) ||
    (flagToken ? sources.length !== 1 : sources.includes(FLAG))
  );
}

function selectActiveSession(
  sessions: Session[],
  flagToken: boolean,
  env: NodeJS.ProcessEnv,
): SelectedSession {
  if (!sessions.length) {
    return {
      failure: unverified("no active session; human authentication required (infisical login)."),
    };
  }
  const sources = sessions.map((session) => session.tokenSource);
  if (ambiguousSources(sources, flagToken))
    return { failure: unverified("session source/domain metadata missing or ambiguous.") };
  const source = flagToken ? FLAG : sources.includes(ENVIRONMENT) ? ENVIRONMENT : KEYRING;
  // login status only reports INFISICAL_TOKEN, while secret commands also accept
  // these legacy aliases. Check names only; never read or copy their values.
  if (
    !flagToken &&
    (Object.hasOwn(env, "INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN") ||
      (source === KEYRING && Object.hasOwn(env, "TOKEN")))
  ) {
    return { failure: unverified("configured credential source is not reported by login status.") };
  }
  const active = sessions.find((session) => session.tokenSource === source);
  return active
    ? { active }
    : { failure: unverified("configured credential source is missing from status.") };
}

function sessionDomainFailure(
  active: Session,
  domain: string | undefined,
): InfisicalStatus | undefined {
  try {
    const expected =
      domain ??
      (active.tokenSource === KEYRING
        ? normalizedDomain(active.domain)
        : "https://app.infisical.com");
    if (normalizedDomain(active.domain) !== expected)
      return unverified("active session does not match the configured domain.");
  } catch {
    return unverified("active session domain is missing or invalid.");
  }
  return undefined;
}

function sessionBackendFailure(active: Session): InfisicalStatus | undefined {
  if (active.status === "expired")
    return unverified("active session expired; human authentication required (infisical login).");
  if (active.status === "rejected" || active.verification?.state === "rejected")
    return unverified(
      "backend rejected the active session; check account access or reauthenticate.",
    );
  if (active.status !== "authenticated" || active.verification?.state !== "verified")
    return unverified("active session backend verification missing, skipped, or unreachable.");
  return undefined;
}

function acceptedStatusExit(
  sessions: Session[],
  active: Session,
  exitCode: number | null,
): boolean {
  if (exitCode === 0) return true;
  // Windows reports externally terminated children as an exit code without
  // reliable signal metadata. Exit 1 is therefore ambiguous there: accepting
  // the stale-secondary exception could approve a truncated status command.
  if (process.platform === "win32") return false;
  // v0.43.96 emits env + selected keyring sessions and exits 1 if EITHER is
  // expired/rejected (packages/cmd/login_status.go). Only that explained exit 1
  // may be ignored; timeouts, signals and unexplained failures still fail.
  const secondaryFailure = sessions.some(
    (session) =>
      session !== active && (session.status === "expired" || session.status === "rejected"),
  );
  return exitCode === 1 && secondaryFailure;
}

function statusResult(
  stdout: string,
  exitCode: number | null,
  domain: string | undefined,
  flagToken: boolean,
  env: NodeJS.ProcessEnv,
): InfisicalStatus {
  const parsed = parseSessions(stdout);
  if ("failure" in parsed) return parsed.failure;
  const selected = selectActiveSession(parsed.sessions, flagToken, env);
  if ("failure" in selected) return selected.failure;
  const failure =
    sessionDomainFailure(selected.active, domain) ?? sessionBackendFailure(selected.active);
  if (failure) return failure;
  if (!acceptedStatusExit(parsed.sessions, selected.active, exitCode))
    return unverified("status command failed.");
  return {
    ok: true,
    output: "Infisical authentication verified by backend for the active session and domain",
  };
}

/** Read-only auth metadata; never starts login or fetches secret values. */
export async function checkInfisicalStatus(
  options: {
    command?: string;
    args?: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<InfisicalStatus> {
  const {
    command = "infisical",
    args = STATUS_ARGS,
    cwd = process.cwd(),
    env = process.env,
  } = options;
  if (!isInfisicalLoginStatus(args))
    return unverified("expected the read-only login status command.");
  let domain: string | undefined;
  try {
    domain = await configuredDomain(args, env, cwd);
  } catch {
    return unverified(
      "configured domain cannot be determined; check the domain setting or workspace binding.",
    );
  }
  const flagToken = args.some((arg) => arg === "--token" || arg.startsWith("--token="));
  try {
    const bin = (await resolveToolBin(command)) ?? command;
    const { stdout } = await exec(bin, args, { timeout: 15_000, cwd, env });
    return statusResult(stdout, 0, domain, flagToken, env);
  } catch (error) {
    const stdout =
      error instanceof Error && "stdout" in error && typeof error.stdout === "string"
        ? error.stdout
        : "";
    const exitCode =
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "number" &&
      !("killed" in error && error.killed) &&
      !("signal" in error && error.signal)
        ? error.code
        : null;
    return statusResult(stdout, exitCode, domain, flagToken, env);
  }
}
