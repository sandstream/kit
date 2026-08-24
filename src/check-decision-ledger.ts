/**
 * The `kit check` face of the decision ledger: require the artifact, verify its shape, and never
 * read a word of its content.
 *
 * Kept separate from the mechanics in `decision-ledger.ts` for the same reason the advisory
 * baseline is: the verdict rules should be readable — and testable — without a filesystem in the
 * way. The four states this returns are the whole gate:
 *
 *   - **nobody required a ledger, and there is none** → skip, with the command that adopts one.
 *     Opt-in by construction. A repo that has not decided to keep a ledger is not failing at it.
 *   - **required, and missing or empty** → `didNotRun`. `gateStatus` fails those by default, so
 *     "green" cannot mean "the run recorded nothing". An empty file is the missing case wearing a
 *     filename.
 *   - **present, and something in it cannot be read** → a plain fail. The check RAN; it found a
 *     hole in the review surface. Not `didNotRun`, because `--lenient` should not be able to wave
 *     a corrupt ledger through as "the scanner was unavailable".
 *   - **present and well-formed** → pass, with the counts that keep the size visible without
 *     opening the file.
 *
 * What is deliberately absent: any verdict about whether a decision was *good*. That belongs to a
 * reviewer, and the moment a gate scores it, the ledger starts being written for the gate. Gate the
 * shape, never the content — the same line `kit standards` and the advisory baseline already hold.
 */

import type { SecurityCheckResult } from "./check-security.js";
import { DECISION_LEDGER_FILE, readLedger, summarise } from "./decision-ledger.js";

const NAME = "decision ledger";

const ADOPT = `Record what the run decided where the spec was silent: \`kit decisions add --decision … --confidence 0.6 --assumed … --would-have-asked …\`.`;

export async function checkDecisionLedger(
  root: string,
  required: boolean,
): Promise<SecurityCheckResult> {
  const base: Omit<SecurityCheckResult, "status" | "detail"> = {
    category: "governance",
    name: NAME,
  };

  let ledger;
  try {
    ledger = await readLedger(root);
  } catch (err) {
    // The file is there and unreadable. That is a scanner-health failure, not an empty ledger.
    return {
      ...base,
      status: "fail",
      severity: "medium",
      didNotRun: true,
      detail: `${DECISION_LEDGER_FILE} could not be read: ${(err as Error).message}`,
    };
  }

  if (ledger === null) {
    if (!required) {
      return {
        ...base,
        status: "skip",
        detail: `no ${DECISION_LEDGER_FILE}, and none required — \`kit decisions add\` starts one; \`[decisions] require = true\` makes it a gate`,
      };
    }
    return {
      ...base,
      status: "fail",
      severity: "medium",
      didNotRun: true,
      detail: `no ${DECISION_LEDGER_FILE} — a governed run that records no decisions leaves no review surface`,
      suggestion: ADOPT,
    };
  }

  if (ledger.problems.length > 0) {
    const shown = ledger.problems
      .slice(0, 3)
      .map((p) => `line ${p.line}: ${p.message}`)
      .join("; ");
    const more = ledger.problems.length > 3 ? `; +${ledger.problems.length - 3} more` : "";
    return {
      ...base,
      status: "fail",
      severity: "medium",
      detail: `${ledger.problems.length} of ${ledger.lines} ledger entr${ledger.lines === 1 ? "y is" : "ies are"} unreadable — ${shown}${more}`,
      suggestion:
        "An entry kit cannot read is a decision nobody can review. Fix the line, or drop it and re-record the decision with `kit decisions add`.",
    };
  }

  const summary = summarise(ledger.entries);
  if (summary.total === 0) {
    if (!required) {
      return {
        ...base,
        status: "skip",
        detail: `${DECISION_LEDGER_FILE} is empty, and no ledger is required`,
      };
    }
    return {
      ...base,
      status: "fail",
      severity: "medium",
      didNotRun: true,
      detail: `${DECISION_LEDGER_FILE} exists but no decisions recorded — an empty ledger is the missing one wearing a filename`,
      suggestion: ADOPT,
    };
  }

  return {
    ...base,
    status: "pass",
    detail: `${summary.total} decision${summary.total === 1 ? "" : "s"} recorded, ${summary.unreviewed} unreviewed (newest ${summary.newest})`,
  };
}
