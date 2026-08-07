/**
 * PreToolUse hook gates, extracted from cli.ts (5.0-alpha god-module split).
 * `kit gate-bash` blocks un-triaged package installs; `kit gate-env` blocks
 * plaintext secrets written to a real `.env*`. Both are fail-open on unparseable
 * payloads (never break the agent) and exit-2 deny on block. The pure decisions
 * live in install-gate.ts / env-write-gate.ts; `gateFormat` (the `--format`
 * reader for the Cline stdout-JSON contract) is used only here, so it stays
 * module-private.
 */

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
    return true; // no stdin / read error → do not block
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
    return true; // unparseable hook payload → do not block (avoid breaking the agent)
  }
  // Agent-agnostic command extraction (Claude/Codex/Amazon Q/Gemini tool_input.command,
  // Cursor top-level command, Cline preToolUse.parameters.command) — shared pure helper.
  const { decideBashGate, extractCommandFromHookPayload } = await import("../install-gate.js");
  const command = extractCommandFromHookPayload(payload);
  if (!command) {
    return true; // no shell command in this tool call → allow
  }
  const verdict = await decideBashGate(command, undefined, process.cwd());
  if (verdict.block) {
    // Cline blocks via a stdout JSON {cancel:true} contract (HookOutputSchema),
    // NOT exit 2 — so `--format cline` emits that and exits 0; every other agent
    // uses the exit-2 PreToolUse deny.
    if (gateFormat() === "cline") {
      console.log(
        JSON.stringify({
          cancel: true,
          errorMessage: `kit install-gate: ${verdict.reason} — triage first (kit triage …) or install via kit pkg <eco>:<name>`,
        }),
      );
      return true;
    }
    const { writeSync } = await import("node:fs");
    writeSync(
      2,
      `kit install-gate: BLOCKED — ${verdict.reason}\nTriage it first: \`kit triage …\`, or install via \`kit pkg <eco>:<name>\`.\n`,
    );
    process.exit(2); // PreToolUse deny
  }
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
  const verdict = decideEnvWriteGate(write.filePath, write.text);
  if (verdict.block) {
    if (gateFormat() === "cline") {
      console.log(
        JSON.stringify({
          cancel: true,
          errorMessage: `kit env-gate: ${verdict.reason} — resolve secrets with \`kit secrets\` (vault-backed) instead of plaintext .env`,
        }),
      );
      return true;
    }
    const { writeSync } = await import("node:fs");
    writeSync(
      2,
      `kit env-gate: BLOCKED — ${verdict.reason}\nNever write secrets to .env* in plaintext. Resolve them with \`kit secrets\` (vault-backed), or use a placeholder in .env.example.\n`,
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
  const { writeSync } = await import("node:fs");
  writeSync(2, `kit ${label}: BLOCKED — ${message}\n`);
  process.exit(2); // PreToolUse deny
}

/**
 * Run a PreToolUse gate FAIL-CLOSED: any unexpected error from the handler DENIES (exit 2 —
 * the block signal) instead of propagating to the CLI's generic error path, which sets exit 1.
 * Exit 1 is a NON-BLOCKING error per the PreToolUse contract, i.e. the tool call would proceed —
 * so an internal fault (e.g. `process.cwd()` throwing ENOENT because the cwd was removed
 * mid-run) would silently ALLOW the very operation the gate exists to mediate. A security gate
 * must fail closed: on any fault, block. Cline uses its stdout {cancel:true} contract instead of
 * exit 2. Returns the handler's boolean when it does not throw.
 */
export async function runGateFailClosed(
  label: string,
  handler: () => boolean | Promise<boolean>,
): Promise<boolean> {
  try {
    return await handler();
  } catch (err) {
    const reason = `gate error (fail-closed): ${err instanceof Error ? err.message : String(err)}`;
    if (gateFormat() === "cline") {
      console.log(JSON.stringify({ cancel: true, errorMessage: `kit ${label}: ${reason}` }));
      return false;
    }
    const { writeSync } = await import("node:fs");
    writeSync(2, `kit ${label}: BLOCKED — ${reason}\n`);
    process.exit(2); // PreToolUse deny — never let an internal fault fail open
  }
}

/**
 * Best-effort audit of a broker-gate deny (design §3.3: every deny leaves an audit entry).
 * Wrapped: a missing/unreadable .kit.toml or audit backend must never change the verdict —
 * the deny already happened, and deny is the safe outcome.
 */
async function auditGateDeny(gate: string, reason: string, sessionId?: string): Promise<void> {
  try {
    const { loadConfig } = await import("../config.js");
    const { mergeGovernanceConfigAsync } = await import("../governance.js");
    const { logAuditEvent } = await import("../audit.js");
    const { resolve } = await import("node:path");
    const cfg = await loadConfig(resolve(process.cwd(), ".kit.toml"));
    const gov = await mergeGovernanceConfigAsync(cfg.governance);
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
 * `kit gate-egress` — PreToolUse egress-gate (exec-broker, Pillar 3). Reads the pending tool
 * call on stdin; if it is a Bash command with explicit http(s) network targets, they must all
 * be inside the SIGNED [scope].egress (via the signed profile policy — fail-closed: a wired gate
 * with no verified scope grants nothing). Off-scope → exit 2 + audit. Commands without an
 * unambiguous URL pass through (conservative extraction; see broker/extract.ts).
 */
export async function cmdGateEgress(): Promise<boolean> {
  const payload = await readHookPayload();
  if (payload === null) return true; // unreadable envelope → never break the agent
  const { extractCommandFromHookPayload } = await import("../install-gate.js");
  const command = extractCommandFromHookPayload(payload);
  if (!command) return true; // not a shell command → allow
  const { extractHostsFromCommand } = await import("../broker/extract.js");
  const hosts = extractHostsFromCommand(command);
  if (hosts.length === 0) return true; // no unambiguous network target → allow

  // Canonical exec-broker: the signed profile scope → BrokerPolicy, egress checked with the
  // shared decisions.checkEgress. A wired gate with no VERIFIED scope grants nothing (policy null).
  const { profileBrokerPolicy } = await import("../exec-broker/profile-policy.js");
  const { checkEgress } = await import("../exec-broker/decisions.js");
  const { policy } = await profileBrokerPolicy(process.cwd());
  let denied: string[];
  let why: string;
  if (!policy) {
    denied = hosts;
    why = `network egress to ${hosts.join(", ")} denied — no verified scope/RoE (unsigned, tampered, or missing); a wired egress-gate grants nothing`;
  } else {
    denied = hosts.filter((h) => !checkEgress(h, { allow: policy.egress.allow }).ok);
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

/** The `--format <fmt>` value for gate-bash (`--format cline` | `--format=cline`). */
function gateFormat(): string {
  const argv = process.argv;
  const eq = argv.find((a) => a.startsWith("--format="));
  if (eq) return eq.slice("--format=".length);
  const i = argv.indexOf("--format");
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : "";
}
