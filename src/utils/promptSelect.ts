import * as readline from "node:readline/promises";

export interface PromptOption {
  value: string;
  label: string;
  /** Optional one-line description shown after the label */
  hint?: string;
  /** Mark this option as the recommended default */
  recommended?: boolean;
}

/**
 * Interactive single-choice prompt. Falls back to the recommended option
 * (or the first option) when stdin is not a TTY — the same convention
 * promptConfirm uses, so CI / piped invocations remain deterministic.
 */
export async function promptSelect(question: string, options: PromptOption[]): Promise<string> {
  const fallback = options.find((o) => o.recommended)?.value ?? options[0]?.value ?? "";

  if (!process.stdin.isTTY) return fallback;
  if (options.length === 0) return "";

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    process.stdout.write(`\n${question}\n`);
    options.forEach((opt, idx) => {
      const star = opt.recommended ? " *" : "  ";
      const hint = opt.hint ? `  — ${opt.hint}` : "";
      process.stdout.write(`  [${idx + 1}]${star} ${opt.label}${hint}\n`);
    });

    const defaultLabel = options.findIndex((o) => o.recommended) + 1 || 1;
    const answer = (
      await rl.question(`Choose [1-${options.length}] (default ${defaultLabel}): `)
    ).trim();

    if (!answer) return fallback;

    const numeric = Number.parseInt(answer, 10);
    if (Number.isFinite(numeric) && numeric >= 1 && numeric <= options.length) {
      return options[numeric - 1].value;
    }

    // Accept value-string match as well (e.g. user types "1password")
    const direct = options.find((o) => o.value.toLowerCase() === answer.toLowerCase());
    if (direct) return direct.value;

    process.stdout.write(`Invalid choice "${answer}" — using default.\n`);
    return fallback;
  } finally {
    rl.close();
  }
}

/**
 * Multi-choice prompt — accepts a comma-separated list of indices or values.
 * Defaults to all "recommended" options if any are flagged, otherwise empty.
 */
export async function promptMultiSelect(
  question: string,
  options: PromptOption[],
): Promise<string[]> {
  const defaults = options.filter((o) => o.recommended).map((o) => o.value);
  if (!process.stdin.isTTY) return defaults;
  if (options.length === 0) return [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    process.stdout.write(`\n${question}\n`);
    options.forEach((opt, idx) => {
      const star = opt.recommended ? " *" : "  ";
      const hint = opt.hint ? `  — ${opt.hint}` : "";
      process.stdout.write(`  [${idx + 1}]${star} ${opt.label}${hint}\n`);
    });

    const defaultStr = defaults.length
      ? defaults.map((v) => options.findIndex((o) => o.value === v) + 1).join(",")
      : "1";
    const answer = (await rl.question(`Choose comma-separated (default ${defaultStr}): `)).trim();

    if (!answer) return defaults;

    const picked = new Set<string>();
    for (const token of answer
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      const num = Number.parseInt(token, 10);
      if (Number.isFinite(num) && num >= 1 && num <= options.length) {
        picked.add(options[num - 1].value);
        continue;
      }
      const direct = options.find((o) => o.value.toLowerCase() === token.toLowerCase());
      if (direct) picked.add(direct.value);
    }
    return [...picked];
  } finally {
    rl.close();
  }
}
