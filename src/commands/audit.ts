// `kit audit` commands — extracted from cli.ts (split step 4).
import { readSecretAuditEvents, groupBySecret, summarize } from "../audit-secrets.js";
import { readAuditLog } from "../audit.js";
import { resolve } from "node:path";
import { printAuditTable } from "../output.js";
import { loadConfig } from "../config.js";
import { resolveConfigPath } from "../cli-shared.js";
import { c } from "../utils/colors.js";
import { hasFlag, flagValue } from "../utils/flags.js";

async function cmdAuditSecrets(): Promise<boolean> {
  const args = process.argv.slice(4); // after "audit secrets"
  const sinceIdx = args.indexOf("--since-days");
  const sinceDays = sinceIdx >= 0 && args[sinceIdx + 1] ? parseInt(args[sinceIdx + 1], 10) : 30;
  const keyFilter = flagValue(args, "--key");
  const jsonMode = hasFlag(args, "--json");

  const events = await readSecretAuditEvents(process.cwd(), sinceDays);
  const { reports, unattributed } = groupBySecret(events);
  const filteredReports = keyFilter ? reports.filter((r) => r.key === keyFilter) : reports;
  const summary = summarize(filteredReports, sinceDays);

  if (jsonMode) {
    console.log(JSON.stringify({ summary, reports: filteredReports, unattributed }, null, 2));
    return true;
  }

  console.log(
    `${c.bold}${c.cyan}kit audit secrets${c.reset}  ${c.dim}(last ${sinceDays}d)${c.reset}`,
  );
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  if (events.length === 0) {
    console.log(`${c.dim}No secret-related events in audit log (.kit-audit.jsonl).${c.reset}\n`);
    return true;
  }

  console.log(
    `${c.bold}${summary.totalEvents}${c.reset} event(s) across ${c.bold}${summary.keyCount}${c.reset} key(s)`,
  );
  if (summary.topKey) {
    console.log(
      `${c.dim}Most touched: ${c.bold}${summary.topKey.key}${c.reset}${c.dim} (${summary.topKey.count} events)${c.reset}`,
    );
  }
  console.log();

  for (const r of filteredReports.slice(0, 20)) {
    console.log(`${c.bold}${r.key}${c.reset}  ${c.dim}(${r.events.length} events)${c.reset}`);
    for (const e of r.events.slice(-10)) {
      const icon = e.success ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
      const ts = e.timestamp.slice(0, 19);
      const agent = e.agent ? `[${e.agent}]` : "";
      const detail = e.detail ? `  ${c.dim}${e.detail}${c.reset}` : "";
      console.log(`  ${icon} ${ts}  ${e.operation}  ${c.dim}${agent}${c.reset}${detail}`);
    }
    if (r.events.length > 10) {
      console.log(`  ${c.dim}… ${r.events.length - 10} earlier events truncated${c.reset}`);
    }
    console.log();
  }

  if (!keyFilter && unattributed.length > 0) {
    console.log(
      `${c.dim}+ ${unattributed.length} event(s) couldn't be tied to a specific key. Use ${c.bold}--json${c.reset}${c.dim} for the full set.${c.reset}\n`,
    );
  }

  return true;
}

/** Resolve the configured audit log file (absolute path), defaulting to ./.kit-audit.jsonl. */
async function resolveAuditLogPath(): Promise<string> {
  let logFile = ".kit-audit.jsonl";
  try {
    const config = await loadConfig(resolveConfigPath());
    if (config.governance?.audit?.log_file) logFile = config.governance.audit.log_file;
  } catch {
    /* default */
  }
  return resolve(process.cwd(), logFile);
}

/**
 * `kit audit verify` - verify the keyless hash chain, then the external HMAC
 * anchor (key + sealed count) when one exists. See audit-anchor.ts for the
 * threat boundary (only a reader of the 0600 key can forge; a same-UID attacker
 * is NOT covered, which needs the external TSA anchor).
 *
 * Fail-closed mode (`--strict` or `[governance.audit].require_anchor = true`,
 * and implicitly once this machine has anchored ANY log) turns an unanchored
 * log, an unreadable key, an unsealed tail, and a rotated key into hard
 * failures, so a project-writable `log_file` cannot silently point verify at a
 * forged, never-anchored file and pass. #fix2 #fix3 #fix4
 */
async function cmdAuditVerify(): Promise<boolean> {
  const { verifyAuditChain } = await import("../audit.js");
  const { readFile } = await import("node:fs/promises");
  const args = process.argv.slice(3);
  const strictFlag = hasFlag(args, "--strict");
  let requireAnchor = false;
  try {
    const config = await loadConfig(resolveConfigPath());
    requireAnchor = config.governance?.audit?.require_anchor === true;
  } catch {
    /* default: not required */
  }
  const logPath = await resolveAuditLogPath();
  let content = "";
  try {
    content = await readFile(logPath, "utf-8");
  } catch {
    // Verify-by-absence is FALSE SECURITY: a deleted / never-anchored log must NOT
    // report "verified". An erased trail is exactly what a tamper-evidence system
    // must catch. Fail closed when strict, require_anchor, or this machine has
    // anchored logs elsewhere (so an attacker can't erase the trail to pass green).
    const { hasAnyAnchoredLogs } = await import("../audit-anchor.js");
    const failClosed = strictFlag || requireAnchor || (await hasAnyAnchoredLogs());
    if (failClosed) {
      console.error(
        `${c.red}✗ no audit log at ${logPath} — refusing to report verified under strict / require_anchor / a machine that has anchored logs. An erased trail is a tamper signal, not a pass.${c.reset}`,
      );
      return false;
    }
    // Genuine fresh install (no strict, no require_anchor, never anchored): surface
    // it as a WARN, not a silent dim pass.
    console.warn(
      `${c.yellow}! no audit log at ${logPath} yet — nothing to verify (fresh install)${c.reset}`,
    );
    return true;
  }
  const r = verifyAuditChain(content);
  if (!r.ok) {
    console.error(
      `${c.red}✗ audit chain BROKEN at entry ${r.brokenAt}: ${r.reason}${c.reset}  ${c.dim}(verified ${r.entries} entries before the break)${c.reset}`,
    );
    return false;
  }
  console.log(`${c.green}✓ audit chain intact${c.reset}  ${c.dim}${r.entries} entries${c.reset}`);

  // Identity-signature layer (orthogonal to the chain): proves WHO produced each
  // entry, not just that nothing was edited. Best-effort attribution — entries
  // signed by a locally-known key verify; unsigned (legacy/keyless) and entries
  // signed by an unknown key are reported but do not fail verify. A FORGED
  // signature (invalid > 0) is a hard failure.
  const { verifyAuditSignatures } = await import("../audit.js");
  const { localPublicKeys, loadRevocations } = await import("../identity.js");
  const trust = localPublicKeys();
  const s = verifyAuditSignatures(content, (kid) => trust.get(kid) ?? null);
  if (s.signed > 0) {
    if (s.invalid > 0) {
      console.error(
        `${c.red}✗ ${s.invalid} signed entr${s.invalid === 1 ? "y has" : "ies have"} an INVALID signature (forged/tampered)${c.reset}`,
      );
    }
    const parts = [`${s.verified}/${s.signed} signatures verified`];
    if (s.unverifiable > 0) parts.push(`${s.unverifiable} from unknown key(s)`);
    if (s.unsigned > 0) parts.push(`${s.unsigned} unsigned`);
    const icon = s.ok ? `${c.green}✓` : `${c.red}✗`;
    console.log(`${icon} identity signatures${c.reset}  ${c.dim}${parts.join(", ")}${c.reset}`);
    // Revocation note (kit panic): entries signed by a now-revoked key are still
    // valid HISTORICAL evidence (the signature was good when made), but that key
    // is no longer trusted for NEW signatures. Surface it; don't fail on it.
    const revoked = new Set(loadRevocations().map((r) => r.kid));
    if (revoked.size > 0) {
      let revokedSigs = 0;
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line) as { kid?: unknown };
          if (typeof o.kid === "string" && revoked.has(o.kid)) revokedSigs++;
        } catch {
          /* chain verifier already covers unparseable lines */
        }
      }
      if (revokedSigs > 0) {
        console.warn(
          `${c.yellow}! ${revokedSigs} entr${revokedSigs === 1 ? "y" : "ies"} signed by a REVOKED key${c.reset} ${c.dim}(valid as history; key no longer trusted for new signatures — kit panic)${c.reset}`,
        );
      }
    }
    if (!s.ok) return false;
  } else if (s.unsigned > 0) {
    console.log(
      `${c.dim}· no identity signatures (${s.unsigned} keyless entries — run \`kit identity\` to start signing)${c.reset}`,
    );
  }

  const {
    readAnchorRecord,
    tryReadAuditAnchorKey,
    verifyAgainstAnchor,
    hasAnyAnchoredLogs,
    decideAnchorVerdict,
  } = await import("../audit-anchor.js");
  const anchor = await readAnchorRecord(logPath);
  const key = await tryReadAuditAnchorKey();
  const a = verifyAgainstAnchor(content, anchor, key);
  const machineHasAnchors = await hasAnyAnchoredLogs();
  const verdict = decideAnchorVerdict({
    result: a,
    strict: strictFlag || requireAnchor,
    machineHasAnchors,
    requireExternal: hasFlag(args, "--require-external"),
  });
  if (verdict.level === "ok") {
    console.log(`${c.green}✓ ${verdict.message}${c.reset}`);
  } else if (verdict.level === "warn") {
    console.warn(`${c.yellow}! ${verdict.message}${c.reset}`);
  } else {
    console.error(`${c.red}✗ HMAC anchor FAILED: ${verdict.message}${c.reset}`);
  }
  return verdict.ok;
}

/**
 * `kit audit anchor` - seal the current log with the machine-local HMAC key so
 * a later key-less rewrite or truncation is detectable by `kit audit verify`.
 */
async function cmdAuditAnchor(): Promise<boolean> {
  const { verifyAuditChain } = await import("../audit.js");
  const { anchorAuditLog } = await import("../audit-anchor.js");
  const { readFile } = await import("node:fs/promises");
  const logPath = await resolveAuditLogPath();
  let content = "";
  try {
    content = await readFile(logPath, "utf-8");
  } catch {
    console.error(`${c.dim}no audit log at ${logPath}; nothing to anchor${c.reset}`);
    return true;
  }
  // Refuse to seal a broken chain: the anchor must vouch for a sound log.
  const chain = verifyAuditChain(content);
  if (!chain.ok) {
    console.error(
      `${c.red}✗ refusing to anchor: chain broken at entry ${chain.brokenAt} (${chain.reason})${c.reset}`,
    );
    return false;
  }
  const external = hasFlag(process.argv.slice(3), "--external");
  try {
    const rec = await anchorAuditLog(logPath, content, undefined, { external });
    console.log(
      `${c.green}✓ audit log anchored${c.reset}  ${c.dim}${rec.count} entries sealed (${rec.algo})${c.reset}`,
    );
    if (rec.external) {
      console.log(
        `${c.green}✓ external anchor receipt${c.reset}  ${c.dim}${rec.external.authority} @ ${rec.external.timestamp}${c.reset}`,
      );
    } else {
      console.log(
        `${c.dim}Note: HMAC-only seal resists a tamperer who cannot read the 0600 anchor key. A same-UID attacker who can read ~/.kit can still forge; close that with \`kit audit anchor --external\` (set KIT_EXTERNAL_ANCHOR_CMD).${c.reset}`,
      );
    }
    return true;
  } catch (err) {
    console.error(`${c.red}✗ could not anchor: ${(err as Error).message}${c.reset}`);
    return false;
  }
}

export async function cmdAudit(): Promise<boolean> {
  const args = process.argv.slice(3);

  // Sub-sub: kit audit secrets [--since-days N] [--key NAME] [--json]
  if (args[0] === "secrets") {
    return cmdAuditSecrets();
  }

  // Sub-sub: kit audit verify - keyless chain + external HMAC anchor.
  if (args[0] === "verify") {
    return cmdAuditVerify();
  }

  // Sub-sub: kit audit anchor - seal the log with the machine-local HMAC key.
  if (args[0] === "anchor") {
    return cmdAuditAnchor();
  }

  // Sub-sub: kit audit export [--format cef|syslog|json] — emit for a SIEM
  if (args[0] === "export") {
    const fmt = (flagValue(args, "--format") ?? "cef") as "cef" | "syslog" | "json";
    if (!["cef", "syslog", "json"].includes(fmt)) {
      console.error(`${c.red}unknown --format "${fmt}" (use cef | syslog | json)${c.reset}`);
      return false;
    }
    let exportLog = ".kit-audit.jsonl";
    try {
      const config = await loadConfig(resolveConfigPath());
      if (config.governance?.audit?.log_file) exportLog = config.governance.audit.log_file;
    } catch {
      /* default */
    }
    const { exportAudit } = await import("../audit-export.js");
    const events = await readAuditLog(exportLog, 1_000_000);
    if (events.length === 0) {
      console.error(`${c.dim}no audit log at ${exportLog}${c.reset}`);
      return true;
    }
    process.stdout.write(exportAudit(events, fmt) + "\n");
    return true;
  }

  // Parse --limit N
  let limit = 20;
  const limitIdx = args.indexOf("--limit");
  if (limitIdx !== -1 && args[limitIdx + 1]) {
    const parsed = parseInt(args[limitIdx + 1], 10);
    if (!isNaN(parsed) && parsed > 0) limit = parsed;
  }

  // Parse --operation <name>
  let operationFilter: string | undefined;
  const opIdx = args.indexOf("--operation");
  if (opIdx !== -1 && args[opIdx + 1]) {
    operationFilter = args[opIdx + 1];
  }

  // Determine log file path (use config if available, else default)
  let logFile = ".kit-audit.jsonl";
  try {
    const config = await loadConfig(resolveConfigPath());
    const govFile = config.governance?.audit?.log_file;
    if (govFile) logFile = govFile;
  } catch {
    // No .kit.toml — use default log file
  }

  let events = await readAuditLog(logFile, limit * 5); // read extra to allow filtering

  if (operationFilter) {
    events = events.filter((e) => e.operation.includes(operationFilter!));
  }

  // Apply limit after filter
  events = events.slice(-limit);

  printAuditTable(events);

  if (events.length > 0) {
    console.log();
    console.log(`${c.dim}Showing ${events.length} entries from ${logFile}${c.reset}`);
  }

  return true;
}
