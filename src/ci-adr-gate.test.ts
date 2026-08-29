/**
 * The ADR gate must be INVOKED by a workflow, not merely exist.
 *
 * Measured on 6.9.0: `docs/adr` held three accepted ADRs carrying four deterministic
 * `kit-enforce` rules; `kit adr check` caught real violations and exited 1; and nothing in the
 * repo ever ran it. Not pre-commit (scan-staged, build, test), not pre-push (npm audit), not
 * `ci.yml`, not `security.yml`. `kit check` does not include the ADR stage — only `kit review`
 * does — and no workflow called either. The rules were armed and unfired for a month.
 *
 * That failure is invisible by construction: a gate nobody runs produces no output, and no output
 * reads exactly like a clean run. The repo already has the mirror of this rule — `self-audit-ci`
 * proves every script a workflow points AT exists — but not its inverse, that a gate which exists
 * is pointed at by something. This is that inverse, for the one gate it has already bitten on.
 *
 * Deliberately asserts on the COMMAND, not on a step name: a renamed step is fine, a deleted
 * invocation is not.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = join(REPO_ROOT, ".github", "workflows");

/** Every workflow's text, keyed by filename, with comment lines stripped — a gate named only in
 *  a comment is not a gate that runs. */
function workflowBodies(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of readdirSync(WORKFLOW_DIR)) {
    if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
    out[file] = readFileSync(join(WORKFLOW_DIR, file), "utf-8")
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
  }
  return out;
}

/** `kit adr check` and `kit review` both run the ADR rules; either satisfies the requirement. */
const INVOKES_ADR = /\b(adr\s+check|kit_review\b|cli\.js\s+review\b|kit\s+review\b)/;

/**
 * `kit skill test --gate` gates one skill; `kit review --stages skill` gates every SKILL.md the
 * repo ships. Either satisfies the requirement, but only the second scales to a second skill.
 */
// NOTE the boundary placement: a leading \b before an alternative starting with `-`
// can never match (space→hyphen is not a word boundary), so each alternative carries
// its own. Caught by deleting the CI step and watching this test stay green.
const INVOKES_SKILL = /(\bskill\s+test\b|--stages[= ][^\n]*\bskill\b|\bkit_review\b)/;

/** The step block that runs `re`, or undefined when no workflow step does. */
function stepRunning(body: string, re: RegExp): string | undefined {
  return body.split(/\n(?=\s*- name:)/).find((block) => re.test(block) && /run:/.test(block));
}

describe("the ADR gate is wired into CI", () => {
  it("is invoked by at least one workflow, outside a comment", () => {
    const hits = Object.entries(workflowBodies())
      .filter(([, body]) => INVOKES_ADR.test(body))
      .map(([file]) => file);
    assert.ok(
      hits.length > 0,
      "no workflow runs `adr check` (or `kit review`, which includes it). " +
        "docs/adr's accepted ADRs carry deterministic rules that then gate nothing — " +
        "which is indistinguishable, in a green build, from having no violations.",
    );
  });

  it("runs it as a hard failure, not a reported-and-ignored step", () => {
    for (const [file, body] of Object.entries(workflowBodies())) {
      if (!INVOKES_ADR.test(body)) continue;
      const step = body
        .split(/\n(?=\s*- name:)/)
        .find((block) => INVOKES_ADR.test(block) && /run:/.test(block));
      if (!step) continue;
      assert.ok(
        !/continue-on-error:\s*true/.test(step),
        `${file} runs the ADR gate with continue-on-error — a gate that cannot fail the build is a report`,
      );
      assert.ok(
        !/\|\|\s*true/.test(step),
        `${file} swallows the ADR gate's exit code with \`|| true\``,
      );
    }
  });
});

describe("the skill gate is wired into CI", () => {
  // Same rule as above, for the gate that was found unfired the same way: `kit skill test`
  // had a working `--gate` (exit 1) and no workflow, hook or `kit review` stage called it,
  // while kit's own only SKILL.md failed its `scope` check. A linter nobody runs cannot be
  // told apart, in a green build, from a repo whose skills are clean.
  it("is invoked by at least one workflow, outside a comment", () => {
    const hits = Object.entries(workflowBodies())
      .filter(([, body]) => INVOKES_SKILL.test(body))
      .map(([file]) => file);
    assert.ok(
      hits.length > 0,
      "no workflow runs the skill gate (`kit review --stages skill` or `kit skill test --gate`). " +
        "Every shipped SKILL.md then declares its scope, or fails to, with nothing checking — " +
        "which looks exactly like having no skills at all.",
    );
  });

  it("runs it as a hard failure, not a reported-and-ignored step", () => {
    for (const [file, body] of Object.entries(workflowBodies())) {
      if (!INVOKES_SKILL.test(body)) continue;
      const step = stepRunning(body, INVOKES_SKILL);
      if (!step) continue;
      assert.ok(
        !/continue-on-error:\s*true/.test(step),
        `${file} runs the skill gate with continue-on-error — a gate that cannot fail the build is a report`,
      );
      assert.ok(
        !/\|\|\s*true/.test(step),
        `${file} swallows the skill gate's exit code with \`|| true\``,
      );
    }
  });
});
