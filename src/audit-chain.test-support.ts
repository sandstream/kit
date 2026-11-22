import { createHash } from "node:crypto";

/** Build audit log content with a valid hash chain, as kit's own writer produces it. */
export function chainedAuditLog(events: readonly Record<string, unknown>[]): string {
  let prev = "0".repeat(64);
  const lines: string[] = [];
  for (const event of events) {
    const preHash = JSON.stringify({ ...event, prev });
    const hash = createHash("sha256").update(preHash).digest("hex");
    lines.push(JSON.stringify({ ...event, prev, hash }));
    prev = hash;
  }
  return lines.map((line) => line + "\n").join("");
}

/** One observe event of the exec broker, before it is chained. */
export function observeEvent(wouldDeny: string[]): Record<string, unknown> {
  return { operation: "bash", success: true, metadata: { phase: "observe", wouldDeny } };
}
