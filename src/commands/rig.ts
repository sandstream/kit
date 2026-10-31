/**
 * `kit rig` — the rig ADR-0007 accepted: kit owns the frozen input, the ingest, the
 * deterministic adjudication and the receipt, never the judgement. kit runs no reviewer.
 *
 *   kit rig plan [rig.toml] [--json]                        the input id and what to run outside kit
 *   kit rig ingest <findings.jsonl> [--manifest p] [--strict] [--json]   store a reviewer's findings
 *   kit rig adjudicate [--manifest p] [--json]              decide caught/missed/false positives, sign
 *   kit rig report [--manifest p] [--json]                  the numbers, with ADR-0007's three limits
 *   kit rig plant --from-fix <sha> --split tune|holdout     plant a defect by reversing a past fix
 *
 * The manifest defaults to `rig.toml` in the current directory.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { c } from "../utils/colors.js";
import { flagValue, GLOBAL_FLAGS, hasFlag, rejectUnknownFlags } from "../utils/flags.js";
import { adjudicate } from "../rig/adjudicate.js";
import { FindingsRefused, ingestFindings, type IngestResult } from "../rig/findings.js";
import { loadManifest, RigManifestError, type RigManifest } from "../rig/manifest.js";
import { renderPlan, renderReport } from "../rig/render.js";
import { cmdRigPlant } from "./rig-plant.js";
import { aggregate, LIMITS, splitWarnings } from "../rig/report.js";
import {
  loadFindings,
  otherInputs,
  readResult,
  receiptPayload,
  saveFindings,
  summarise,
  writeResult,
  type RigReceipt,
  type RigResult,
} from "../rig/store.js";

const USAGE = `Usage: kit rig [plan | ingest | adjudicate | report | plant]

  plan        [rig.toml] [--json]
  ingest      <findings.jsonl> [--manifest <rig.toml>] [--strict] [--json]
  adjudicate  [--manifest <rig.toml>] [--json]
  report      [--manifest <rig.toml>] [--json]
  plant       --from-fix <sha> --split tune|holdout [--id <id>] [--kind <kind>] [--repo <dir>] [--path <file>] [--pinned <sha>] [--manifest <rig.toml>] [--json]`;

const PLAN_FLAGS = ["--json", ...GLOBAL_FLAGS];
const INGEST_FLAGS = ["--manifest", "--strict", "--json", ...GLOBAL_FLAGS];
const READ_FLAGS = ["--manifest", "--json", ...GLOBAL_FLAGS];

/** The first positional argument after the subcommand, skipping flag values. */
function positional(withValues: string[]): string | undefined {
  const args = process.argv.slice(4);
  for (let i = 0; i < args.length; i++) {
    if (withValues.includes(args[i])) {
      i++;
      continue;
    }
    if (!args[i].startsWith("--")) return args[i];
  }
  return undefined;
}

function fail(msg: string): false {
  console.error(`${c.red}kit rig: ${msg}${c.reset}`);
  return false;
}

async function load(path: string): Promise<{ manifest: RigManifest; inputId: string } | null> {
  try {
    return await loadManifest(resolve(path));
  } catch (err) {
    if (err instanceof RigManifestError) fail(`${path}: ${err.message}`);
    else fail(`${path}: could not be read`);
    return null;
  }
}

async function cmdPlan(): Promise<boolean> {
  if (rejectUnknownFlags("kit rig plan", PLAN_FLAGS)) return false;
  const path = positional([]) ?? "rig.toml";
  const loaded = await load(path);
  if (!loaded) return false;
  if (hasFlag(process.argv, "--json")) {
    console.log(JSON.stringify({ inputId: loaded.inputId, manifest: loaded.manifest }, null, 2));
    return true;
  }
  for (const line of renderPlan(loaded.manifest, loaded.inputId, "findings.jsonl"))
    console.log(line);
  return true;
}

async function cmdIngest(cwd: string): Promise<boolean> {
  if (rejectUnknownFlags("kit rig ingest", INGEST_FLAGS)) return false;
  const file = positional(["--manifest"]);
  if (!file) return fail(`ingest needs a findings file\n${USAGE}`);
  const loaded = await load(flagValue(process.argv, "--manifest") ?? "rig.toml");
  if (!loaded) return false;
  let text: string;
  try {
    text = await readFile(resolve(file), "utf8");
  } catch {
    return fail(`${file}: could not be read`);
  }
  let ingest: IngestResult;
  try {
    ingest = ingestFindings(text, { strict: hasFlag(process.argv, "--strict") });
  } catch (err) {
    return fail(
      err instanceof FindingsRefused ? `${file}: refused, ${err.message}` : `${file}: refused`,
    );
  }
  if (ingest.runs.length === 0) return fail(`${file}: no valid rows`);
  const unknown = adjudicate(loaded.manifest, ingest).unknownTargets;
  if (unknown.length > 0 && hasFlag(process.argv, "--strict")) {
    return fail(
      `${file}: refused, target(s) not in the manifest: ${[...new Set(unknown.map((u) => u.target))].join(", ")}`,
    );
  }
  const saved = await saveFindings(cwd, loaded.inputId, text);
  const out = {
    inputId: loaded.inputId,
    sha: saved.sha,
    added: saved.added,
    findings: ingest.findings.length,
    runs: ingest.runs.length,
    errors: ingest.errors,
    unknownTargets: unknown.length,
  };
  if (hasFlag(process.argv, "--json")) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(
      `${saved.added ? "stored" : "already stored"} ${saved.sha.slice(0, 12)} for input ${loaded.inputId.slice(0, 12)}: ${out.findings} finding(s), ${out.runs} run(s)`,
    );
    for (const e of ingest.errors) console.log(`${c.yellow}line ${e.line}: ${e.message}${c.reset}`);
    if (unknown.length > 0)
      console.log(
        `${c.yellow}${unknown.length} run(s) name a target not in the manifest; they will not be counted${c.reset}`,
      );
  }
  return true;
}

/** Sign the receipt with the active identity when one exists; never fail adjudication over it. */
async function sign(
  cwd: string,
  inputId: string,
  findings: string[],
  summary: RigReceipt["summary"],
): Promise<RigReceipt> {
  const receipt: RigReceipt = { inputId, findings, summary, signature: null };
  try {
    const { keystoreSign, hardwareRequired } = await import("../keystore/active.js");
    receipt.signature = keystoreSign(receiptPayload(inputId, findings, summary), {
      required: hardwareRequired(cwd),
    }).toString("base64");
  } catch (err) {
    receipt.unsignedReason =
      err instanceof Error ? err.message.split("\n")[0].slice(0, 160) : "signing failed";
  }
  return receipt;
}

/** Best-effort audit event: a missing .kit.toml or audit backend never aborts adjudication. */
async function audit(cwd: string, result: RigResult): Promise<void> {
  try {
    const { loadConfig } = await import("../config.js");
    const { mergeGovernanceConfigAsync } = await import("../governance.js");
    const { logAuditEvent } = await import("../audit.js");
    const cfg = await loadConfig(resolve(cwd, ".kit.toml")).catch(
      () => ({}) as Awaited<ReturnType<typeof loadConfig>>,
    );
    const gov = await mergeGovernanceConfigAsync(cfg?.governance);
    await logAuditEvent(
      gov,
      {
        operation: "rig.adjudicate",
        environment: gov.environment,
        success: true,
        metadata: {
          inputId: result.inputId,
          findings: result.receipt.findings,
          summary: result.receipt.summary,
          signed: result.receipt.signature !== null,
        },
      },
      { cwd },
    );
  } catch {
    /* best-effort — result.json and its signature are the record */
  }
}

async function cmdAdjudicate(cwd: string): Promise<boolean> {
  if (rejectUnknownFlags("kit rig adjudicate", READ_FLAGS)) return false;
  const loaded = await load(flagValue(process.argv, "--manifest") ?? "rig.toml");
  if (!loaded) return false;
  const files = await loadFindings(cwd, loaded.inputId);
  if (files.length === 0)
    return fail(
      `no findings ingested for input ${loaded.inputId.slice(0, 12)} (a changed prompt, patch or manifest is a new input)`,
    );
  const merged: IngestResult = { findings: [], runs: [], errors: [] };
  for (const f of files) {
    const one = ingestFindings(f.text);
    merged.findings.push(...one.findings);
    merged.runs.push(...one.runs);
  }
  const { outcomes, unknownTargets } = adjudicate(loaded.manifest, merged);
  const stats = aggregate(loaded.manifest, outcomes);
  const shas = files.map((f) => f.sha);
  const result: RigResult = {
    inputId: loaded.inputId,
    adjudicatedAt: new Date().toISOString(),
    outcomes,
    unknownTargets,
    stats,
    warnings: splitWarnings(stats),
    receipt: await sign(cwd, loaded.inputId, shas, summarise(stats)),
  };
  const path = await writeResult(cwd, result);
  await audit(cwd, result);
  if (hasFlag(process.argv, "--json")) console.log(JSON.stringify(result, null, 2));
  else
    console.log(
      `adjudicated ${outcomes.length} run-target(s) from ${shas.length} file(s); wrote ${path}${result.receipt.signature ? " (signed)" : ""}`,
    );
  return true;
}

async function cmdReport(cwd: string): Promise<boolean> {
  if (rejectUnknownFlags("kit rig report", READ_FLAGS)) return false;
  const loaded = await load(flagValue(process.argv, "--manifest") ?? "rig.toml");
  if (!loaded) return false;
  const result = await readResult(cwd, loaded.inputId);
  if (!result)
    return fail(
      `no adjudication for input ${loaded.inputId.slice(0, 12)}; run kit rig adjudicate first`,
    );
  const others = await otherInputs(cwd, loaded.inputId);
  if (hasFlag(process.argv, "--json")) {
    console.log(JSON.stringify({ ...result, otherInputs: others, limits: LIMITS }, null, 2));
    return true;
  }
  for (const line of renderReport(result, others)) console.log(line);
  return true;
}

export async function cmdRig(): Promise<boolean> {
  const sub = process.argv[3];
  const cwd = process.cwd();
  if (sub === "plan") return cmdPlan();
  if (sub === "ingest") return cmdIngest(cwd);
  if (sub === "adjudicate") return cmdAdjudicate(cwd);
  if (sub === "report") return cmdReport(cwd);
  if (sub === "plant") return cmdRigPlant();
  console.error(sub ? `${c.red}unknown subcommand: ${sub}${c.reset}` : USAGE);
  if (sub) console.error(USAGE);
  return false;
}
