import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";

export const TRIAGE_LOG_FILE = ".kit-triage.jsonl";

export interface TriageLogEntry {
  timestamp: string;
  type: string;
  target: string;
  sandbox: boolean;
  deep?: boolean;
  granter: string;
  /** Exact npm spec evaluated by a kit-driven install, when more specific than target. */
  triagedSpec?: string;
}

export interface TriagePassInput {
  type: string;
  target: string;
  sandbox: boolean;
  deep?: boolean;
  cwd?: string;
  triagedSpec?: string;
}

/** Append one PASS receipt. Callers decide whether a write failure blocks their operation. */
export async function appendTriagePass(input: TriagePassInput): Promise<void> {
  const entry: TriageLogEntry = {
    timestamp: new Date().toISOString(),
    type: input.type,
    target: input.target,
    sandbox: input.sandbox,
    deep: input.deep ?? false,
    granter: process.env.USER ?? "unknown",
    ...(input.triagedSpec ? { triagedSpec: input.triagedSpec } : {}),
  };
  await appendFile(
    resolve(input.cwd ?? process.cwd(), TRIAGE_LOG_FILE),
    JSON.stringify(entry) + "\n",
    "utf-8",
  );
}
