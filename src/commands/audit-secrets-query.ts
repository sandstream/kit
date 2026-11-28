// `kit audit secrets --key <NAME> --since <ISO> [--json]`. See src/audit-secrets-query.ts.
import {
  queryKeyAccess,
  type KeyAccessAnswer,
  type KeyAccessEvent,
} from "../audit-secrets-query.js";
import { c } from "../utils/colors.js";
import { flagValue, hasFlag } from "../utils/flags.js";

/** A full ISO 8601 date or date-time. Anything else is refused rather than guessed. */
function parseSince(raw: string | undefined): Date | undefined {
  if (!raw || !/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/.test(raw)) return undefined;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? undefined : at;
}

function who(e: KeyAccessEvent): string {
  const parts = [e.agent, e.harness, e.via].filter(Boolean);
  return parts.length > 0 ? parts.join(" / ") : "caller not recorded";
}

function printAnswer(a: KeyAccessAnswer): void {
  console.log(`${c.bold}${c.cyan}kit audit secrets --key ${a.key} --since ${a.since}${c.reset}`);
  console.log(`Coverage: ${a.coverage}.`);
  const icon = a.chain.verified ? `${c.green}✓` : `${c.red}✗`;
  const state = a.chain.verified ? "verified" : `NOT verified (${a.chain.status})`;
  console.log(`${icon} audit chain ${state}${c.reset}  ${c.dim}${a.chain.detail}${c.reset}\n`);
  console.log(`${a.reads} read(s) and ${a.writes} write(s) of ${a.key} recorded through kit.`);
  for (const e of a.events) {
    const where = e.store ? ` from ${e.store}` : e.target ? ` to ${e.target}` : "";
    const ok = e.success ? "" : ` ${c.red}(failed)${c.reset}`;
    console.log(
      `  ${e.timestamp.slice(0, 19)}  ${e.kind.padEnd(5)}  ${e.operation}${where}  by ${who(e)}${ok}`,
    );
  }
  if (a.unattributed > 0)
    console.log(
      `${c.yellow}!${c.reset} ${a.unattributed} secret event(s) in the window name no key (recorded before kit recorded key names); they may include ${a.key}.`,
    );
  if (!a.chain.verified)
    console.error(
      `${c.red}✗ The audit chain did not verify, so this answer cannot be relied on. Run \`kit audit verify\`.${c.reset}`,
    );
}

/** Exit 0 only when the answer comes from a verified chain. */
export async function cmdAuditSecretsQuery(args: string[], logPath: string): Promise<boolean> {
  const key = flagValue(args, "--key");
  const since = parseSince(flagValue(args, "--since"));
  if (!key || !since) {
    console.error(
      "Usage: kit audit secrets --key <NAME> --since <ISO 8601 date or date-time> [--json]",
    );
    return false;
  }
  const answer = await queryKeyAccess(logPath, key, since);
  if (hasFlag(args, "--json")) console.log(JSON.stringify(answer, null, 2));
  else printAnswer(answer);
  return answer.chain.verified;
}
