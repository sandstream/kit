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
  let raw = "";
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
  const verdict = await decideBashGate(command);
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
  let raw = "";
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

/** The `--format <fmt>` value for gate-bash (`--format cline` | `--format=cline`). */
function gateFormat(): string {
  const argv = process.argv;
  const eq = argv.find((a) => a.startsWith("--format="));
  if (eq) return eq.slice("--format=".length);
  const i = argv.indexOf("--format");
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : "";
}
