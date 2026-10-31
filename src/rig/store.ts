/**
 * Where the rig keeps what it was given and what it decided, under `.kit/rig/<input-id>/`:
 *
 *   findings/<sha256>.jsonl   each ingested file, byte-for-byte, named by its own hash
 *   result.json               the last adjudication: outcomes, stats, warnings, receipt
 *
 * Keying by the input id means findings for one frozen question are never mixed with findings
 * for another: change the prompt, a patch or the manifest and the id changes with it. Storing
 * files by their hash makes a re-ingest of the same file a no-op and lets a receipt name
 * exactly which files produced its numbers.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunOutcome } from "./adjudicate.js";
import type { ConfigStats } from "./report.js";
import type { RunMark } from "./findings.js";

export const RIG_DIR = join(".kit", "rig");

export interface RigReceipt {
  inputId: string;
  findings: string[];
  summary: Record<
    string,
    { tuneRecall: number | null; holdoutRecall: number | null; controlFpRate: number | null }
  >;
  /** base64 Ed25519 signature over `receiptPayload(...)`, or null when no identity could sign. */
  signature: string | null;
  unsignedReason?: string;
}

export interface RigResult {
  inputId: string;
  adjudicatedAt: string;
  outcomes: RunOutcome[];
  unknownTargets: RunMark[];
  stats: ConfigStats[];
  warnings: string[];
  receipt: RigReceipt;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function inputDir(cwd: string, inputId: string): string {
  return join(cwd, RIG_DIR, inputId);
}

/** Store an ingested findings file under its hash. Returns the hash and whether it was new. */
export async function saveFindings(
  cwd: string,
  inputId: string,
  text: string,
): Promise<{ sha: string; added: boolean }> {
  const sha = sha256(text);
  const dir = join(inputDir(cwd, inputId), "findings");
  await mkdir(dir, { recursive: true });
  const existing = await readdir(dir).catch(() => [] as string[]);
  if (existing.includes(`${sha}.jsonl`)) return { sha, added: false };
  await writeFile(join(dir, `${sha}.jsonl`), text, { flag: "wx" });
  return { sha, added: true };
}

/** Every stored findings file for an input, in hash order. */
export async function loadFindings(
  cwd: string,
  inputId: string,
): Promise<{ sha: string; text: string }[]> {
  const dir = join(inputDir(cwd, inputId), "findings");
  const names = (await readdir(dir).catch(() => [] as string[]))
    .filter((n) => /^[0-9a-f]{64}\.jsonl$/.test(n))
    .sort();
  const out: { sha: string; text: string }[] = [];
  for (const name of names) {
    out.push({ sha: name.slice(0, 64), text: await readFile(join(dir, name), "utf8") });
  }
  return out;
}

/** The other input ids on record, so a report can say what it did not mix in. */
export async function otherInputs(cwd: string, inputId: string): Promise<string[]> {
  const names = await readdir(join(cwd, RIG_DIR)).catch(() => [] as string[]);
  return names.filter((n) => /^[0-9a-f]{64}$/.test(n) && n !== inputId).sort();
}

export async function writeResult(cwd: string, result: RigResult): Promise<string> {
  const path = join(inputDir(cwd, result.inputId), "result.json");
  await mkdir(inputDir(cwd, result.inputId), { recursive: true });
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`);
  return path;
}

export async function readResult(cwd: string, inputId: string): Promise<RigResult | null> {
  try {
    return JSON.parse(
      await readFile(join(inputDir(cwd, inputId), "result.json"), "utf8"),
    ) as RigResult;
  } catch {
    return null;
  }
}

/** One recall summary per config, rounded to 4 places so the signed bytes are stable. */
export function summarise(stats: ConfigStats[]): RigReceipt["summary"] {
  const r = (v: number | undefined | null): number | null =>
    v === undefined || v === null ? null : Math.round(v * 10000) / 10000;
  return Object.fromEntries(
    stats.map((s) => [
      s.config,
      {
        tuneRecall: r(s.tune.recall?.mean),
        holdoutRecall: r(s.holdout.recall?.mean),
        controlFpRate: r(s.controls.falsePositiveRate?.mean),
      },
    ]),
  );
}

/** The exact bytes a receipt signs: input id, findings hashes and summary, keys sorted. */
export function receiptPayload(
  inputId: string,
  findings: string[],
  summary: RigReceipt["summary"],
): string {
  const configs = Object.keys(summary).sort();
  return JSON.stringify({
    kind: "kit-rig-receipt-v1",
    inputId,
    findings: [...findings].sort(),
    summary: configs.map((c) => [
      c,
      summary[c].tuneRecall,
      summary[c].holdoutRecall,
      summary[c].controlFpRate,
    ]),
  });
}
