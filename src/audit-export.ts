/**
 * Export audit events in SIEM-friendly formats.
 *
 * `kit audit export` lets a regulated/air-gapped deployment ship its local
 * `.kit-audit.jsonl` into a SIEM. ArcSight **CEF** is the lingua franca; the CEF
 * line is commonly carried over syslog, so `--format syslog` wraps each CEF line
 * in an RFC 5424 frame. Pure string formatting — no I/O — so it is fully tested.
 */
import type { AuditEvent } from "./audit.js";

/** CEF header fields escape `\` and `|`. */
function cefHeader(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/** CEF extension values escape `\`, `=`, and newlines. */
function cefExt(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/=/g, "\\=").replace(/\r?\n/g, " ");
}

/**
 * One ArcSight CEF line per event.
 * `CEF:0|kit|kit|<ver>|<sig>|<name>|<sev>|<ext>`
 */
export function toCef(event: AuditEvent, productVersion = "1"): string {
  const sev = event.success ? 3 : 7; // failures rank higher for SIEM triage
  const sig = event.operation || "operation";
  const header = `CEF:0|kit|kit|${cefHeader(productVersion)}|${cefHeader(sig)}|${cefHeader(sig)}|${sev}`;

  const ext: string[] = [];
  const epoch = Date.parse(event.timestamp);
  if (Number.isFinite(epoch)) ext.push(`rt=${epoch}`);
  ext.push(`outcome=${event.success ? "success" : "failure"}`);
  const user = event.agent_name || event.agent_id;
  if (user) ext.push(`suser=${cefExt(user)}`);
  if (event.environment) ext.push(`cs1Label=environment cs1=${cefExt(event.environment)}`);
  if (typeof event.duration_ms === "number")
    ext.push(`cn1Label=durationMs cn1=${event.duration_ms}`);
  if (event.error) ext.push(`msg=${cefExt(event.error)}`);

  return `${header}|${ext.join(" ")}`;
}

/** RFC 5424 syslog frame around a message. PRI 13 = facility 1 (user), severity 5 (notice). */
export function toSyslog(event: AuditEvent, host = "kit"): string {
  const ts = event.timestamp || new Date().toISOString();
  // <PRI>VERSION TIMESTAMP HOSTNAME APP-NAME PROCID MSGID STRUCTURED-DATA MSG
  return `<13>1 ${ts} ${host} kit - audit - ${toCef(event)}`;
}

export type AuditExportFormat = "cef" | "syslog" | "json";

/** Render a batch of events in the chosen format, one record per line. */
export function exportAudit(events: AuditEvent[], format: AuditExportFormat): string {
  const lines = events.map((e) => {
    switch (format) {
      case "cef":
        return toCef(e);
      case "syslog":
        return toSyslog(e);
      case "json":
        return JSON.stringify(e);
    }
  });
  return lines.join("\n");
}
