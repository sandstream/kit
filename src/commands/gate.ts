/**
 * PreToolUse hook gates, extracted from cli.ts (5.0-alpha god-module split).
 * `kit gate-bash` blocks un-triaged package installs; `kit gate-env` blocks
 * plaintext secrets written to a real `.env*`. Both are fail-open on unparseable
 * payloads (never break the agent) and exit-2 deny on block. The pure decisions
 * live in install-gate.ts / env-write-gate.ts; `gateFormat` (the `--format`
 * reader for the Cline stdout-JSON contract) is used only here, so it stays
 * module-private.
 */
import { writeSync } from "node:fs";

/**
 * `kit gate-bash` — PreToolUse install-gate handler. Reads a coding agent's
 * pending-tool-call JSON on stdin ({ tool_name, tool_input: { command } }), and
 * if it is a Bash command that adds an un-triaged package, BLOCKS it by exiting 2
 * (the deny signal for Claude Code / Codex / Amazon Q PreToolUse hooks; exit 1
 * would be a non-blocking error). Allow → exit 0. This is what makes
 * "installs nothing untriaged" hold even in agent auto-mode. Wire it with
 * `kit agent-config --install-gate`. Pure decision lives in install-gate.ts.
 */
export async function cmdGateBash(): Promise<boolean> {
  let raw: string;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    raw = Buffer.concat(chunks).toString("utf8");
  } catch {
    return stdoutAllow(); // no stdin / read error → do not block
  }
  let payload: {
    tool_name?: string;
    tool_input?: { command?: unknown };
    command?: unknown;
    preToolUse?: { toolName?: string; parameters?: { command?: unknown } };
  };
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return stdoutAllow(); // unparseable hook payload → do not block (avoid breaking the agent)
  }
  // "Triage it first" is the right next step for a blocked PACKAGE, and nonsense for a refusal
  // about shell semantics — a double-quoted backtick is command substitution, not a package to
  // triage. Appending it there is what made a correct block read as a mis-parse (#501), so the
  // advice follows the reason instead of being stapled to every refusal.
  const triageAdvice = (reason: string, lead = ". "): string =>
    /COMMAND SUBSTITUTION|UNVERIFIED COMMAND|UNVERIFIED SOURCE|cannot be undone|trusted root|approvals off/.test(
      reason,
    )
      ? ""
      : `${lead}Triage it first: \`kit triage …\`, or install via \`kit pkg <eco>:<name>\`.`;

  // Agent-agnostic command extraction (Claude/Codex/Amazon Q/Gemini tool_input.command,
  // Cursor top-level command, Cline preToolUse.parameters.command) — shared pure helper.
  const { decideBashGate, extractCommandFromHookPayload } = await import("../install-gate.js");
  const command = extractCommandFromHookPayload(payload);
  if (!command) {
    return stdoutAllow(); // no shell command in this tool call → allow
  }
  const { trailCommandRefusal } = await import("../trail-guard.js");
  const { homedir } = await import("node:os");
  if (await refuseTrail("gate-bash", trailCommandRefusal(command, homedir()), payload)) return true;
  const { gateSettingsCommandRefusal } = await import("../gate-self-edit.js");
  const selfEdit = gateSettingsCommandRefusal(command, process.cwd(), homedir());
  if (await refuseTrail("gate-bash", selfEdit, payload)) return true;
  const verdict = await decideBashGate(command, undefined, process.cwd());
  if (verdict.block) {
    await auditGateDeny("gate-bash", verdict.reason, sessionIdOf(payload));
    // Cline and Antigravity read a stdout JSON verdict and exit 0; every other agent
    // uses the exit-2 PreToolUse deny.
    if (stdoutDeny(`kit install-gate: ${verdict.reason}${triageAdvice(verdict.reason)}`)) {
      return true;
    }
    writeSync(
      2,
      `kit install-gate: BLOCKED: ${verdict.reason}${triageAdvice(verdict.reason, "\n")}\n`,
    );
    process.exit(2); // PreToolUse deny
  }
  const { writePassWarnings } = await import("../triage-warnings.js");
  await writePassWarnings("kit install-gate", verdict.checked);
  return stdoutAllow(verdict.notes);
}

/**
 * Refuse a tool call that would change kit's own trail (trail-guard.ts). Returns false when there
 * is nothing to refuse; otherwise audits the deny and blocks (stdout JSON or exit 2).
 */
async function refuseTrail(
  gate: string,
  reason: string | null,
  payload: unknown,
): Promise<boolean> {
  if (!reason) return false;
  await auditGateDeny(gate, `trail-guard: ${reason}`, sessionIdOf(payload));
  const message = `kit trail-guard: ${reason}. If this is intended, run it yourself (in Claude Code, prefix it with !).`;
  if (stdoutDeny(message)) return true;
  writeSync(
    2,
    `kit trail-guard: BLOCKED: ${reason}\nIf this is intended, run it yourself (in Claude Code, prefix it with !).\n`,
  );
  process.exit(2); // PreToolUse deny
}

/**
 * A deny on stdout for the harnesses whose contract is stdout JSON: Cline's `{cancel: true}`
 * (HookOutputSchema), and Antigravity's required `decision` (its docs give no exit-code meaning).
 */
function stdoutDeny(message: string): boolean {
  const format = gateFormat();
  if (format === "cline") console.log(JSON.stringify({ cancel: true, errorMessage: message }));
  else if (format === "antigravity")
    console.log(JSON.stringify({ decision: "deny", reason: message }));
  else return false;
  return true;
}

/**
 * Allow. Antigravity requires a `decision` on every PreToolUse reply. `notes` name what the
 * allowed command runs untriaged (install-gate-notes.ts); they go to stderr, never to the
 * stdout verdict.
 */
function stdoutAllow(notes: readonly string[] = []): boolean {
  for (const note of notes) process.stderr.write(`kit install-gate: note: ${note}\n`);
  if (gateFormat() === "antigravity") console.log(JSON.stringify({ decision: "allow" }));
  return true;
}

/**
 * PreToolUse hook body for the env-write-gate: block a Write/Edit that puts a
 * plaintext secret into a real `.env*` file, BEFORE it lands. Mirrors gate-bash:
 * fail-open on unparseable payloads (never break the agent), exit-2 deny on block.
 */
export async function cmdGateEnv(): Promise<boolean> {
  let raw: string;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    raw = Buffer.concat(chunks).toString("utf8");
  } catch {
    return true; // no stdin / read error → do not block
  }
  let payload: unknown;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return true; // unparseable hook payload → do not block (avoid breaking the agent)
  }
  const { extractWriteFromHookPayload, decideEnvWriteGate } = await import("../env-write-gate.js");
  const write = extractWriteFromHookPayload(payload);
  if (!write) return true; // not a file write → allow
  const { trailWriteRefusal } = await import("../trail-guard.js");
  const { homedir } = await import("node:os");
  const trail = trailWriteRefusal(write.filePath, process.cwd(), homedir());
  if (await refuseTrail("gate-env", trail, payload)) return true;
  const { gateSettingsWriteRefusal } = await import("../gate-self-edit.js");
  const selfEdit = gateSettingsWriteRefusal(payload, process.cwd(), homedir());
  if (await refuseTrail("gate-env", selfEdit, payload)) return true;
  const verdict = decideEnvWriteGate(write.filePath, write.text);
  if (verdict.block) {
    await auditGateDeny("gate-env", verdict.reason ?? "secret write", sessionIdOf(payload));
    if (gateFormat() === "cline") {
      console.log(
        JSON.stringify({
          cancel: true,
          errorMessage: `kit env-gate: ${verdict.reason} — resolve secrets with \`kit secrets\` (vault-backed) instead of plaintext .env`,
        }),
      );
      return true;
    }
    writeSync(
      2,
      `kit env-gate: BLOCKED: ${verdict.reason}\nNever write secrets to .env* in plaintext. Resolve them with \`kit secrets\` (vault-backed), or use a placeholder in .env.example.\n`,
    );
    process.exit(2); // PreToolUse deny
  }
  return true;
}

/**
 * Shared stdin reader for the exec-broker gates: the pending-tool-call JSON, or `null` when
 * the envelope is unreadable/unparseable. The envelope comes from the agent HARNESS (not the
 * model), so an unparseable one is a harness/config problem — fail-open like gate-bash/gate-env
 * (never break the agent on garbage), while the scope decisions themselves stay fail-closed.
 */
async function readHookPayload(): Promise<unknown | null> {
  let raw: string;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    raw = Buffer.concat(chunks).toString("utf8");
  } catch {
    return null;
  }
  try {
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

/** Deny helper for the broker gates: Cline stdout-JSON contract or exit-2 PreToolUse deny. */
async function gateDeny(label: string, message: string): Promise<boolean> {
  if (gateFormat() === "cline") {
    console.log(JSON.stringify({ cancel: true, errorMessage: `kit ${label}: ${message}` }));
    return true;
  }
  writeSync(2, `kit ${label}: BLOCKED — ${message}\n`);
  process.exit(2); // PreToolUse deny
}

/**
 * `kit panic --stop` (stop-switch.ts): while `~/.kit/stop` exists, every gate refuses every tool
 * call before deciding anything else. Returns true when it refused (Cline: stdout JSON).
 */
async function stopInEffect(label: string): Promise<boolean> {
  const { readStop } = await import("../stop-switch.js");
  const { homedir } = await import("node:os");
  const stop = readStop(homedir());
  if (!stop) return false;
  const reason = `kit panic --stop is in effect since ${stop.since} (${stop.reason}): every gated tool call is refused. A person runs \`kit panic --resume\` to lift it.`;
  await auditGateDeny(label, reason);
  if (stdoutDeny(`kit ${label}: ${reason}`)) return true;
  writeSync(2, `kit ${label}: BLOCKED — ${reason}\n`);
  process.exit(2); // PreToolUse deny
}

/**
 * Run a PreToolUse gate FAIL-CLOSED: any unexpected error from the handler DENIES (exit 2 —
 * the block signal) instead of propagating to the CLI's generic error path, which sets exit 1.
 * Exit 1 is a NON-BLOCKING error per the PreToolUse contract, i.e. the tool call would proceed —
 * so an internal fault (e.g. `process.cwd()` throwing ENOENT because the cwd was removed
 * mid-run) would silently ALLOW the very operation the gate exists to mediate. A security gate
 * must fail closed: on any fault, block. Cline and Antigravity get their stdout-JSON deny instead
 * of exit 2 (see denyGateFault). Returns the handler's boolean when it does not throw.
 */
export async function runGateFailClosed(
  label: string,
  handler: () => boolean | Promise<boolean>,
  io: GateDenyIo = GATE_DENY_IO,
): Promise<boolean> {
  try {
    if (await stopInEffect(label)) return false;
    return await handler();
  } catch (err) {
    return denyGateFault(label, err, io);
  }
}

/** What the fault deny writes with. Injectable so a test can make each writer fail. */
export interface GateDenyIo {
  /** The stdout-JSON deny for Cline / Antigravity; false when the harness reads exit 2. */
  stdoutDeny: (message: string) => boolean;
  writeStderr: (text: string) => void;
  exit: (code: number) => never;
}

// Everything here is loaded with this module: `writeSync` is a static import and `process` is
// always present. A deny that first has to load a module fails exactly when module loading is
// the fault (kit-research#233 E3: every payload exited 1, i.e. allowed, in a V8-snapshot build).
const GATE_DENY_IO: GateDenyIo = {
  stdoutDeny,
  writeStderr: (text) => writeSync(2, text),
  exit: (code) => process.exit(code),
};

/** The fault's message, or a fixed text when even reading it throws. */
function faultMessage(err: unknown): string {
  try {
    return err instanceof Error ? err.message : String(err);
  } catch {
    return "unprintable error";
  }
}

/**
 * DENY after an internal gate fault, whatever else fails. The stdout-JSON harnesses get their
 * `{cancel}` / `{decision: "deny"}` and the handler returns false; every other harness gets the
 * reason on stderr and exit 2, the only PreToolUse exit code that blocks (exit 1 is a
 * non-blocking error: the tool call would run). If writing the deny throws, a fixed line goes to
 * `process.stderr` and the exit is still 2.
 */
export function denyGateFault(label: string, err: unknown, io: GateDenyIo = GATE_DENY_IO): false {
  try {
    const reason = `gate error (fail-closed): ${faultMessage(err)}`;
    if (io.stdoutDeny(`kit ${label}: ${reason}`)) return false;
    io.writeStderr(`kit ${label}: BLOCKED — ${reason}\n`);
  } catch {
    try {
      process.stderr.write(`kit ${label}: BLOCKED — gate error (fail-closed)\n`);
    } catch {
      /* nothing left to write with; the exit code below still denies */
    }
  }
  return io.exit(2); // PreToolUse deny — never let an internal fault fail open
}

/**
 * Best-effort audit of a gate deny (design §3.3: every deny leaves an audit entry), for every
 * PreToolUse gate, with or without a .kit.toml.
 * Wrapped: a missing/unreadable .kit.toml or audit backend must never change the verdict —
 * the deny already happened, and deny is the safe outcome.
 */
async function auditGateDeny(gate: string, reason: string, sessionId?: string): Promise<void> {
  try {
    const { loadConfig } = await import("../config.js");
    const { mergeGovernanceConfigAsync } = await import("../governance.js");
    const { logAuditEvent } = await import("../audit.js");
    const { resolve } = await import("node:path");
    // No .kit.toml is not "no audit": a deny in an unconfigured repo is recorded with defaults.
    const cfg = await loadConfig(resolve(process.cwd(), ".kit.toml")).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    });
    const gov = await mergeGovernanceConfigAsync(cfg?.governance);
    // The session_id join key lets `kit skill test --runtime` attribute this deny to the
    // skill run that was active when it fired (negative-control HELD evidence) — session-bounded,
    // not a global timestamp guess. Omitted from metadata when the harness gave no session.
    const metadata: Record<string, unknown> = { phase: "pretooluse-deny" };
    if (sessionId) metadata.session_id = sessionId;
    await logAuditEvent(gov, {
      operation: gate,
      environment: gov.environment,
      success: false,
      error: reason,
      metadata,
    });
  } catch {
    /* best-effort — see above */
  }
}

/** Read the harness-supplied `session_id` off a PreToolUse payload; "" when absent. */
function sessionIdOf(payload: unknown): string {
  if (payload && typeof payload === "object") {
    const s = (payload as { session_id?: unknown }).session_id;
    if (typeof s === "string") return s;
  }
  return "";
}

/**
 * Under a verified scope, add the hosts git would contact for `git push|fetch|pull|ls-remote|
 * clone|remote update` (remote names resolved via `git remote get-url`). A remote git cannot
 * resolve becomes an "unknown host" denial. Returns the extra denials.
 */
async function gitEgressTargets(command: string, hosts: string[]): Promise<string[]> {
  const { resolveGitTargets } = await import("../broker/git-remote-hosts.js");
  const git = await resolveGitTargets(command, process.cwd());
  for (const h of git.hosts) if (!hosts.includes(h)) hosts.push(h);
  return git.unresolved.map((name) => `unknown host (unresolvable git remote "${name}")`);
}

/**
 * `kit gate-egress` — PreToolUse egress-gate (exec-broker, Pillar 3). Reads the pending tool
 * call on stdin; if it is a Bash command with explicit http(s) network targets, they must all
 * be inside the SIGNED [scope].egress (via the signed profile policy — fail-closed: a wired gate
 * with no verified scope grants nothing). Off-scope → exit 2 + audit. Under a verified scope,
 * git network commands are resolved to their remote's host too (broker/git-remote-hosts.ts).
 * So are the host targets of bare-host network tools (`nc`, `ping`, `nmap`, `ssh`, …; see
 * broker/bare-hosts.ts), denied like a URL with no verified scope. Other commands pass through.
 */
export async function cmdGateEgress(): Promise<boolean> {
  const payload = await readHookPayload();
  if (payload === null) return true; // unreadable envelope → never break the agent
  const { extractCommandFromHookPayload } = await import("../install-gate.js");
  const command = extractCommandFromHookPayload(payload);
  if (!command) return true; // not a shell command → allow
  const { extractHostsFromCommand } = await import("../broker/extract.js");
  const { findGitNetworkCommands } = await import("../broker/git-remote-hosts.js");
  const hosts = extractHostsFromCommand(command);
  const hasGit = findGitNetworkCommands(command, process.cwd()).length > 0;
  if (hosts.length === 0 && !hasGit) return true; // no network target → allow

  // Canonical exec-broker: the signed profile scope → BrokerPolicy, egress checked with the
  // shared decisions.checkEgress. A wired gate with no VERIFIED scope grants nothing (policy null).
  const { profileBrokerPolicy } = await import("../exec-broker/profile-policy.js");
  const { checkEgress } = await import("../exec-broker/decisions.js");
  const { policy } = await profileBrokerPolicy(process.cwd());
  let denied: string[];
  let why: string;
  if (!policy) {
    if (hosts.length === 0) return true; // no verified scope: git remotes pass, as before
    denied = hosts;
    why = `network egress to ${hosts.join(", ")} denied — no verified scope/RoE (unsigned, tampered, or missing); a wired egress-gate grants nothing`;
  } else {
    const unknown = hasGit ? await gitEgressTargets(command, hosts) : [];
    denied = [
      // An address range (`nmap 10.0.0.0/24`) is never inside a host scope.
      ...hosts.filter((h) => h.includes("/") || !checkEgress(h, { allow: policy.egress.allow }).ok),
      ...unknown,
    ];
    why = `host(s) outside the signed egress scope: ${denied.join(", ")}`;
  }
  if (denied.length === 0) return true;
  await auditGateDeny("gate-egress", why, sessionIdOf(payload));
  return await gateDeny(
    "egress-gate",
    `${why}\nDeclare the host in .kit-profile.toml [scope].egress and re-sign: \`kit profile sign\`.`,
  );
}

/**
 * `kit gate-fs` — PreToolUse fs-gate (exec-broker, Pillar 3). Reads the pending tool call on
 * stdin; a Write/Edit must target a path inside the SIGNED [scope].fs (default: the project
 * root), via the signed profile policy — fail-closed: a wired gate with no verified scope grants
 * nothing. Off-scope → exit 2 + audit. Non-write tool calls pass through.
 */
export async function cmdGateFs(): Promise<boolean> {
  const payload = await readHookPayload();
  if (payload === null) return true; // unreadable envelope → never break the agent
  const { extractWriteFromHookPayload } = await import("../env-write-gate.js");
  const write = extractWriteFromHookPayload(payload);
  if (!write) return true; // not a file write → allow

  // Canonical exec-broker: signed profile scope → BrokerPolicy; the write must land under some
  // allowed root, checked with the shared decisions.checkFsWrite. No verified scope → deny.
  const { profileBrokerPolicy } = await import("../exec-broker/profile-policy.js");
  const { checkFsWrite } = await import("../exec-broker/decisions.js");
  const { checkFsWriteRealpath } = await import("../exec-broker/realpath-check.js");
  const { policyFsRoots } = await import("../exec-broker/policy.js");
  const { resolve } = await import("node:path");
  const { policy } = await profileBrokerPolicy(process.cwd());
  if (!policy) {
    const why = `write to ${write.filePath} denied — no verified scope/RoE (unsigned, tampered, or missing); a wired fs-gate grants nothing`;
    await auditGateDeny("gate-fs", why, sessionIdOf(payload));
    return await gateDeny("fs-gate", `${why}\nSign the profile scope: \`kit profile sign\`.`);
  }
  // Resolve the hook's path against the agent cwd, then require BOTH gates per root — the pure
  // string/traversal check AND the symlink-aware realpath check — exactly as the canonical broker
  // (broker.ts collectDenials) does. Without the realpath check a symlink inside a signed root
  // pointing outside would let the write escape scope (the enforcement point must not be weaker
  // than the broker it mirrors).
  const abs = resolve(process.cwd(), write.filePath);
  if (
    policyFsRoots(policy).some(
      (root) => checkFsWrite(abs, root).ok && checkFsWriteRealpath(abs, root).ok,
    )
  )
    return true;
  const why = `write outside the signed fs scope: ${write.filePath}`;
  await auditGateDeny("gate-fs", why);
  return await gateDeny(
    "fs-gate",
    `${why}\nDeclare the path in .kit-profile.toml [scope].fs and re-sign: \`kit profile sign\`.`,
  );
}

/**
 * `kit gate-limits` — PreToolUse per-session limits (session-limits.ts): wall-clock minutes, tool
 * calls and child agents from `.kit.toml [governance.agent]`. Opt-in, matched to every tool. No
 * limit set, or no session id in the payload → allow without counting.
 */
export async function cmdGateLimits(): Promise<boolean> {
  const payload = await readHookPayload();
  if (payload === null) return true; // unreadable envelope → never break the agent
  const sessionId = sessionIdOf(payload);
  const tool = (payload as { tool_name?: unknown }).tool_name;
  if (!sessionId || typeof tool !== "string") return true;
  const limits = await configuredSessionLimits();
  const { hasLimits, decideSessionLimits, sessionStatePath, readSessionState, writeSessionState } =
    await import("../session-limits.js");
  if (!hasLimits(limits)) return true;
  const { homedir } = await import("node:os");
  const path = sessionStatePath(homedir(), sessionId);
  const verdict = decideSessionLimits(limits, readSessionState(path), tool, new Date());
  if ("next" in verdict) {
    writeSessionState(path, verdict.next);
    return true;
  }
  const why = `${verdict.refuse}; stop and hand the remaining work to a person`;
  await auditGateDeny("gate-limits", why, sessionId);
  return await gateDeny("limits-gate", why);
}

/** The per-session limits in `.kit.toml [governance.agent]`; none when there is no config. */
async function configuredSessionLimits(): Promise<import("../session-limits.js").SessionLimits> {
  const { loadConfig } = await import("../config.js");
  const { resolve } = await import("node:path");
  const cfg = await loadConfig(resolve(process.cwd(), ".kit.toml")).catch(() => undefined);
  const agent = cfg?.governance?.agent;
  return {
    maxSessionMinutes: agent?.max_session_minutes,
    maxToolCalls: agent?.max_tool_calls_per_session,
    maxChildAgents: agent?.max_child_agents,
  };
}

/** The `--format <fmt>` value for gate-bash (`--format cline` | `--format=cline`). */
function gateFormat(): string {
  const argv = process.argv;
  const eq = argv.find((a) => a.startsWith("--format="));
  if (eq) return eq.slice("--format=".length);
  const i = argv.indexOf("--format");
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : "";
}
