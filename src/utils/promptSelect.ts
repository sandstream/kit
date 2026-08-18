import * as readline from "node:readline/promises";
import { askQuestion } from "./askQuestion.js";
import type { PromptIO } from "./promptMultiSelect.js";

export interface PromptOption {
  value: string;
  label: string;
  /** Optional one-line description shown after the label */
  hint?: string;
  /** Mark this option as the recommended default */
  recommended?: boolean;
}

/**
 * Interactive single-choice prompt. Falls back to the recommended option (or the first
 * option) whenever nobody answers — no TTY, Ctrl+D, or a closed input — the same convention
 * promptConfirm uses, so CI / piped invocations remain deterministic. `promptMultiSelect`
 * deliberately does NOT share that convention; see the note there for why.
 *
 * `io` exists so the question can be driven in a test; production passes nothing.
 */
export async function promptSelect(
  question: string,
  options: PromptOption[],
  io: PromptIO = { input: process.stdin, output: process.stdout },
): Promise<string> {
  const fallback = options.find((o) => o.recommended)?.value ?? options[0]?.value ?? "";

  if (!io.input.isTTY) return fallback;
  if (options.length === 0) return "";

  const rl = readline.createInterface({
    input: io.input,
    output: io.output,
  });

  try {
    io.output.write(`\n${question}\n`);
    options.forEach((opt, idx) => {
      const star = opt.recommended ? " *" : "  ";
      const hint = opt.hint ? `  — ${opt.hint}` : "";
      io.output.write(`  [${idx + 1}]${star} ${opt.label}${hint}\n`);
    });

    const defaultLabel = options.findIndex((o) => o.recommended) + 1 || 1;
    const raw = await askQuestion(rl, `Choose [1-${options.length}] (default ${defaultLabel}): `);
    if (raw === null) {
      // Ctrl+D or a closed input. Unhandled this ended the whole command on a node stack
      // trace at the moment the user tried to back out, which reads like kit crashed. The
      // documented no-answer behaviour applies instead — and it says out loud which option
      // that left standing, because a silent default is how the wrong backend gets chosen.
      io.output.write(`\nNo answer — using "${fallback}".\n`);
      return fallback;
    }
    const answer = raw.trim();

    if (!answer) return fallback;

    const numeric = Number.parseInt(answer, 10);
    if (Number.isFinite(numeric) && numeric >= 1 && numeric <= options.length) {
      return options[numeric - 1].value;
    }

    // Accept value-string match as well (e.g. user types "1password")
    const direct = options.find((o) => o.value.toLowerCase() === answer.toLowerCase());
    if (direct) return direct.value;

    io.output.write(`Invalid choice "${answer}" — using default.\n`);
    return fallback;
  } finally {
    rl.close();
  }
}
