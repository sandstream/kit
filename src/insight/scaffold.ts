/**
 * Repeat→codify scaffold for Pelare 4's insight loop
 * (`pillar4-insight-loop-5.0.md`, step 4). `memory learn` already FINDS recurring
 * instructions deterministically (learnRecurring — pure counting, no ML); this
 * turns a found LearnCandidate into a skill-DRAFT skeleton the operator reviews.
 *
 * Deterministic + pure (candidate → text): the *detection* and the *skeleton* are
 * core/free. Only the eventual filling-in of the skill body may be model-assisted,
 * opt-in and AROUND the core — never here. Output is a `.draft.md` (never a live
 * skill) so nothing is auto-installed.
 */
import type { LearnCandidate } from "../memory/learn.js";

export interface SkillScaffold {
  /** Suggested draft filename, e.g. "run-tests-before-committing.skill.draft.md". */
  filename: string;
  /** The skeleton markdown (frontmatter + intent + step stubs). */
  content: string;
}

/**
 * Deterministic slug from free text: lowercased, non-alphanumerics collapsed to
 * single dashes, trimmed, capped to 60 chars. Empty input → "recurring-instruction".
 */
export function slugify(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return s.length > 0 ? s : "recurring-instruction";
}

/**
 * Turn a recurring-instruction candidate into a reviewable skill draft. Pure:
 * same candidate → same scaffold (no timestamps/randomness), so it is safe to
 * regenerate and diff.
 */
export function scaffoldFromCandidate(candidate: LearnCandidate): SkillScaffold {
  const slug = slugify(candidate.normalized || candidate.example);
  const sessions = `${candidate.sessions} session${candidate.sessions === 1 ? "" : "s"}`;
  const kind = candidate.correction ? "correction/redirection" : "instruction";
  const content = `---
name: ${slug}
description: "DRAFT — auto-scaffolded from a recurring ${kind}; edit before use"
---

# ${slug}

> Scaffolded by \`kit memory learn --scaffold\` from an instruction you repeated
> **${candidate.count}×** across **${sessions}**. This is a DRAFT, not an installed
> skill — review, fill the steps, then move it into place if it is worth keeping.

## Intent

${candidate.example}

## Steps

1. TODO: first concrete step
2. TODO: …

## Notes

- Recurrence: ${candidate.count}× across ${sessions}${candidate.correction ? " (often phrased as a correction — you keep having to redirect toward this)" : ""}.
- kit found this by counting; it did not judge whether it *should* be a skill. That is your call.
`;
  return { filename: `${slug}.skill.draft.md`, content };
}
