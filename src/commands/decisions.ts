/**
 * `kit decisions` — the intake and the reader for the per-run decision ledger.
 *
 *   kit decisions add      record one choice made where the spec was silent
 *   kit decisions list     what this run has recorded (--json, --unreviewed)
 *   kit decisions verify   the gate's verdict, on its own exit code (--json)
 *
 * WHY THE COMMAND EXISTS AT ALL. `kit check` can fail a governed run that recorded no decisions.
 * A gate whose artifact has no producer is a dead end, so the producer ships with it. What kit
 * does NOT do is write the entries itself: deciding what was assumed and what it would have asked
 * is model work, and the zero-LLM core does not do model work. kit provides the form and refuses a
 * malformed one; the agent or the operator provides the content.
 *
 * `verify` calls the SAME `checkDecisionLedger` the security gate calls, rather than
 * re-implementing the rules next door. Two implementations of "is this ledger acceptable" is two
 * verdicts, and the surface that disagrees is always the one nobody is watching.
 *
 * `add` refuses exactly what `verify` refuses — a missing fact, a confidence outside 0..1 — so an
 * operator never learns the schema by having a line rejected after the fact.
 */

import { randomBytes } from "node:crypto";
import { relative } from "node:path";
import { c } from "../utils/colors.js";
import { hasFlag, flagValue, rejectUnknownFlags, GLOBAL_FLAGS } from "../utils/flags.js";
import { loadConfig } from "../config.js";
import { resolveConfigPath } from "../cli-shared.js";
import {
  DECISION_LEDGER_FILE,
  MIN_CONFIDENCE,
  MAX_CONFIDENCE,
  appendEntry,
  newEntry,
  readLedger,
  summarise,
  type DecisionEntry,
} from "../decision-ledger.js";
import { checkDecisionLedger } from "../check-decision-ledger.js";

const USAGE = `Usage: kit decisions [add | list | verify]

  add     --decision <text> --confidence <${MIN_CONFIDENCE}..${MAX_CONFIDENCE}> --assumed <text> --would-have-asked <text>
  list    [--json] [--unreviewed]
  verify  [--json]`;

const ADD_FLAGS = [
  "--decision",
  "--confidence",
  "--assumed",
  "--would-have-asked",
  "--json",
  ...GLOBAL_FLAGS,
];
const LIST_FLAGS = ["--json", "--unreviewed", ...GLOBAL_FLAGS];
const VERIFY_FLAGS = ["--json", ...GLOBAL_FLAGS];

/** Short, readable, and unguessable enough for a handle nothing authorises on. */
const shortId = (): string => randomBytes(4).toString("hex");

function truncate(text: string, width: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

async function ledgerRequired(): Promise<boolean> {
  try {
    const config = await loadConfig(resolveConfigPath());
    return config?.decisions?.require === true;
  } catch {
    // No readable config is not a requirement — the same posture the check takes.
    return false;
  }
}

async function cmdAdd(cwd: string): Promise<boolean> {
  if (rejectUnknownFlags("kit decisions add", ADD_FLAGS)) return false;
  const json = hasFlag(process.argv, "--json");

  const fields = {
    "--decision": flagValue(process.argv, "--decision"),
    "--confidence": flagValue(process.argv, "--confidence"),
    "--assumed": flagValue(process.argv, "--assumed"),
    "--would-have-asked": flagValue(process.argv, "--would-have-asked"),
  };
  const missing = Object.entries(fields)
    .filter(([, value]) => value === undefined || value.trim() === "")
    .map(([flag]) => flag);
  if (missing.length > 0) {
    // Named, not counted: the point of the ledger is the fields, so the refusal has to say which
    // fact is absent rather than "invalid arguments".
    console.error(`${c.red}missing: ${missing.join(", ")}${c.reset}`);
    console.error(
      `${c.dim}Every entry carries four facts: what was decided, how sure, what was assumed, and the question it would have asked.${c.reset}`,
    );
    console.error(USAGE);
    return false;
  }

  const confidence = Number.parseFloat(fields["--confidence"] as string);
  if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE || confidence > MAX_CONFIDENCE) {
    console.error(
      `${c.red}--confidence must be a number between ${MIN_CONFIDENCE} and ${MAX_CONFIDENCE}${c.reset} (got: ${fields["--confidence"]})`,
    );
    return false;
  }

  const entry = newEntry(
    {
      decision: (fields["--decision"] as string).trim(),
      confidence,
      assumed: (fields["--assumed"] as string).trim(),
      wouldHaveAsked: (fields["--would-have-asked"] as string).trim(),
    },
    new Date(),
    shortId,
  );
  const path = await appendEntry(cwd, entry);

  if (json) {
    console.log(JSON.stringify({ entry, file: relative(cwd, path) }, null, 2));
    return true;
  }
  console.log(
    `${c.green}✓${c.reset} recorded ${c.bold}${entry.id}${c.reset} in ${DECISION_LEDGER_FILE} — ${truncate(entry.decision, 60)}`,
  );
  return true;
}

function printList(entries: DecisionEntry[]): void {
  const idWidth = Math.max(2, ...entries.map((e) => e.id.length));
  for (const entry of entries) {
    const mark = entry.reviewed ? `${c.green}✓${c.reset}` : `${c.dim}·${c.reset}`;
    console.log(
      `  ${mark} ${c.bold}${entry.id.padEnd(idWidth)}${c.reset} ${c.dim}${entry.confidence.toFixed(2)}${c.reset}  ${truncate(entry.decision, 72)}`,
    );
    console.log(`      ${c.dim}assumed:${c.reset} ${truncate(entry.assumed, 68)}`);
    console.log(
      `      ${c.dim}would have asked:${c.reset} ${truncate(entry.would_have_asked, 58)}`,
    );
  }
}

async function cmdList(cwd: string): Promise<boolean> {
  if (rejectUnknownFlags("kit decisions list", LIST_FLAGS)) return false;
  const json = hasFlag(process.argv, "--json");
  const onlyUnreviewed = hasFlag(process.argv, "--unreviewed");

  let ledger;
  try {
    ledger = await readLedger(cwd);
  } catch (err) {
    console.error(
      `${c.red}${DECISION_LEDGER_FILE} could not be read: ${(err as Error).message}${c.reset}`,
    );
    return false;
  }
  const all = ledger?.entries ?? [];
  const entries = onlyUnreviewed ? all.filter((e) => !e.reviewed) : all;

  if (json) {
    console.log(JSON.stringify({ entries, problems: ledger?.problems ?? [] }, null, 2));
    return true;
  }

  if (entries.length === 0) {
    console.log(
      `${c.dim}no decisions recorded in ${DECISION_LEDGER_FILE} — \`kit decisions add\` records one${c.reset}`,
    );
    return true;
  }

  const summary = summarise(all);
  console.log(
    `${c.bold}${summary.total}${c.reset} decision${summary.total === 1 ? "" : "s"} · ${summary.unreviewed} unreviewed\n`,
  );
  printList(entries);
  // Problems are shown even here: a reader who sees five entries and not the sixth unreadable line
  // is reading a ledger that lies by omission.
  for (const problem of ledger?.problems ?? []) {
    console.log(`  ${c.yellow}!${c.reset} line ${problem.line}: ${problem.message}`);
  }
  return true;
}

async function cmdVerify(cwd: string): Promise<boolean> {
  if (rejectUnknownFlags("kit decisions verify", VERIFY_FLAGS)) return false;
  const json = hasFlag(process.argv, "--json");

  // The same function `kit check` calls — one definition of an acceptable ledger, so the CLI and
  // the gate cannot drift into two different verdicts.
  const result = await checkDecisionLedger(cwd, await ledgerRequired());
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return result.status !== "fail";
  }

  const icon =
    result.status === "pass"
      ? `${c.green}✓${c.reset}`
      : result.status === "fail"
        ? `${c.red}✗${c.reset}`
        : `${c.dim}−${c.reset}`;
  console.log(`${icon} ${result.detail}`);
  if (result.status === "fail" && result.suggestion) {
    console.log(`${c.dim}${result.suggestion}${c.reset}`);
  }
  return result.status !== "fail";
}

export async function cmdDecisions(): Promise<boolean> {
  const sub = process.argv[3] ?? "list";
  const cwd = process.cwd();

  if (sub === "add") return cmdAdd(cwd);
  if (sub === "list") return cmdList(cwd);
  if (sub === "verify") return cmdVerify(cwd);

  console.error(`${c.red}unknown subcommand: ${sub}${c.reset}`);
  console.error(USAGE);
  return false;
}
