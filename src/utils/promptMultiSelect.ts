import * as readline from "node:readline/promises";

export interface MultiSelectOption {
  value: string;
  label: string;
  /** Optional one-line description shown after the label. */
  hint?: string;
  /** Start out ticked — used for options the repo itself evidences. */
  preselected?: boolean;
}

export interface MultiSelectAnswer {
  /** Chosen values, in the order typed, deduped. */
  picked: string[];
  /** Tokens that matched neither an index nor a value — reported, never guessed at. */
  unknown: string[];
}

/**
 * Pure half of `promptMultiSelect`: turn what the human typed into values.
 *
 * Lives apart from the readline plumbing so the input rules are testable without a TTY —
 * the rules are where the bugs are, not in the printing.
 *
 * Rules: comma/space separated tokens; a token is either a 1-based index into `options` or
 * an option value (case-insensitive). `""` means "keep the ticked set", `"none"` means
 * nothing. Only an all-digits token counts as an index, so `"3x"` is reported as unknown
 * instead of quietly selecting option 3 — a near-miss must not become a silent yes.
 */
export function parseMultiSelectAnswer(
  answer: string,
  options: MultiSelectOption[],
): MultiSelectAnswer {
  const trimmed = answer.trim();
  if (!trimmed) {
    return { picked: options.filter((o) => o.preselected).map((o) => o.value), unknown: [] };
  }
  if (trimmed.toLowerCase() === "none") return { picked: [], unknown: [] };

  const picked: string[] = [];
  const unknown: string[] = [];
  for (const token of trimmed.split(/[\s,]+/).filter(Boolean)) {
    if (/^\d+$/.test(token)) {
      const idx = Number.parseInt(token, 10);
      if (idx >= 1 && idx <= options.length) {
        picked.push(options[idx - 1].value);
        continue;
      }
    }
    const direct = options.find((o) => o.value.toLowerCase() === token.toLowerCase());
    if (direct) {
      picked.push(direct.value);
      continue;
    }
    unknown.push(token);
  }
  return { picked: [...new Set(picked)], unknown };
}

/**
 * Interactive multiple-choice prompt.
 *
 * Returns `null` — never a default — when stdin is not a TTY. That is the whole point of
 * this helper existing next to `promptSelect`, which answers with its `recommended` option
 * in the same situation. That convention silently decided a secret backend for every
 * `kit init` run from an agent or a CI job, because "nobody is here to answer" was treated
 * as "answer with kit's favourite". A null says only what is true: the question was not put
 * to anybody. The caller decides what that means — usually "leave it out and report a gap".
 *
 * Input format: comma/space separated numbers or value names ("1,3" / "sentry posthog"),
 * empty input accepts the preselected set, and "none" selects nothing.
 */
export async function promptMultiSelect(
  question: string,
  options: MultiSelectOption[],
): Promise<string[] | null> {
  if (!process.stdin.isTTY) return null;
  if (options.length === 0) return [];

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`\n${question}\n`);
    options.forEach((opt, idx) => {
      const tick = opt.preselected ? "x" : " ";
      const hint = opt.hint ? `  — ${opt.hint}` : "";
      process.stdout.write(`  [${idx + 1}] (${tick}) ${opt.label}${hint}\n`);
    });

    const answer = await rl.question(
      `Select (numbers or names, "none" for none) [enter = keep ticked]: `,
    );
    const { picked, unknown } = parseMultiSelectAnswer(answer, options);
    for (const token of unknown) {
      process.stdout.write(`Ignoring unknown choice "${token}".\n`);
    }
    return picked;
  } finally {
    rl.close();
  }
}
