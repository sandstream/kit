/**
 * `collectReview({cwd})` must describe the project it was asked about, in every stage.
 *
 * `collectReview` looked threaded: it passes `opts.cwd` to all four stages. But `runDesignGate`
 * passed that `cwd` to `loadBaselineForGate` and then called `checkDesign(...)` WITHOUT it, and
 * `checkDesign` resolved its source roots — and the display path of every finding — from
 * `process.cwd()`. So the baseline came from B while the files scanned came from A. A parameter
 * that reaches one collaborator and not the next is the same false green as no parameter at all,
 * and reading `collectReview` alone would never show it.
 *
 * Each test asserts the two trees produce DIFFERENT findings. Fixtures matter more than usual
 * here: while writing them I twice produced "the two trees are identical" and twice it was the
 * FIXTURE, not the code — an ADR file in MADR heading style that kit's parser (YAML frontmatter
 * with an `id`) correctly ignored, and a standards stage whose five rows only measure tool
 * availability, which two temp dirs share. A probe that cannot tell the hypothesis from its
 * negation is not evidence, so each fixture below differs in something the stage actually reads.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectReview } from "./commands/review.js";

function baseProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-review-cwd-"));
  writeFileSync(join(dir, ".kit.toml"), "version = 1\n");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "rv", version: "1.0.0", private: true }) + "\n",
  );
  return dir;
}

/** A component with an a11y violation the design stage reports on (img without alt). */
function withComponent(dir: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "Bad.tsx"), 'export const Bad = () => <img src="x.png" />;\n');
}

/** An ADR in the shape kit's parser accepts: YAML frontmatter with an `id`, plus an enforce block. */
function withAdr(dir: string): void {
  mkdirSync(join(dir, "docs", "adr"), { recursive: true });
  writeFileSync(
    join(dir, "docs", "adr", "0001-no-axios.md"),
    [
      "---",
      "id: ADR-0001",
      "title: No axios",
      "status: accepted",
      "---",
      "",
      "## Decision",
      "",
      "Use fetch.",
      "",
      "```toml kit-enforce",
      "[[forbid_pattern]]",
      'pattern = "axios"',
      'paths = "src/**/*.tsx"',
      'message = "use fetch"',
      "```",
      "",
    ].join("\n"),
  );
}

async function inCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prevCwd = process.cwd();
  const prevId = process.env.KIT_IDENTITY_DIR;
  const idDir = mkdtempSync(join(tmpdir(), "kit-review-id-"));
  process.env.KIT_IDENTITY_DIR = idDir;
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prevCwd);
    if (prevId === undefined) delete process.env.KIT_IDENTITY_DIR;
    else process.env.KIT_IDENTITY_DIR = prevId;
    rmSync(idDir, { recursive: true, force: true });
  }
}

type Report = Awaited<ReturnType<typeof collectReview>>;

function stage(r: Report, name: string): Report["stages"][number] | undefined {
  return r.stages.find((s) => s.stage === name);
}

describe("collectReview honours cwd in every stage", () => {
  it("the design stage scans the governed tree's components, not the process's", async () => {
    const A = baseProject();
    const B = baseProject();
    withComponent(A); // A has a component with a violation; B has no src/ at all
    try {
      const aboutA = await inCwd(A, () => collectReview({ cwd: A, stages: ["design"] }));
      const aboutB = await inCwd(A, () => collectReview({ cwd: B, stages: ["design"] }));

      const a = stage(aboutA, "design");
      const b = stage(aboutB, "design");
      // The pair is the assertion: before the fix both answers described A.
      assert.notDeepEqual(
        b?.findings,
        a?.findings,
        "a project with no components must not inherit A's design findings",
      );
      assert.equal((a?.findings.length ?? 0) > (b?.findings.length ?? 0), true);
    } finally {
      rmSync(A, { recursive: true, force: true });
      rmSync(B, { recursive: true, force: true });
    }
  });

  it("a design finding's file path is relative to the governed tree", async () => {
    const A = baseProject();
    const B = baseProject();
    withComponent(B); // this time the component is in the TARGET, not the process's tree
    try {
      const aboutB = await inCwd(A, () => collectReview({ cwd: B, stages: ["design"] }));
      const text = JSON.stringify(stage(aboutB, "design")?.findings ?? []);
      // `relative(process.cwd(), file)` produced a path escaping upward out of A (../…/src/Bad.tsx)
      // for a file that sits plainly at src/Bad.tsx inside B.
      assert.doesNotMatch(text, /\.\.\//, `a finding must not be reported via a ../ path: ${text}`);
    } finally {
      rmSync(A, { recursive: true, force: true });
      rmSync(B, { recursive: true, force: true });
    }
  });

  it("the adr stage reads the governed tree's ADRs", async () => {
    const A = baseProject();
    const B = baseProject();
    withAdr(A); // A has one accepted, enforcing ADR; B has none
    try {
      const aboutA = await inCwd(A, () => collectReview({ cwd: A, stages: ["adr"] }));
      const aboutB = await inCwd(A, () => collectReview({ cwd: B, stages: ["adr"] }));

      assert.match(
        JSON.stringify(stage(aboutA, "adr")?.findings),
        /enforced ADR/,
        "A declares an enforcing ADR",
      );
      assert.match(
        JSON.stringify(stage(aboutB, "adr")?.findings),
        /no ADRs found/,
        "B declares none and must be reported as such",
      );
    } finally {
      rmSync(A, { recursive: true, force: true });
      rmSync(B, { recursive: true, force: true });
    }
  });

  it("the check stage still discriminates through collectReview", async () => {
    const A = baseProject();
    const B = baseProject();
    writeFileSync(join(A, ".gitignore"), ".env\n.env.local\n.env.*.local\nnode_modules\n");
    try {
      const aboutA = await inCwd(A, () => collectReview({ cwd: A, stages: ["check"] }));
      const aboutB = await inCwd(A, () => collectReview({ cwd: B, stages: ["check"] }));
      assert.notDeepEqual(
        stage(aboutB, "check")?.findings,
        stage(aboutA, "check")?.findings,
        "B has no .gitignore and must not inherit A's security verdict",
      );
    } finally {
      rmSync(A, { recursive: true, force: true });
      rmSync(B, { recursive: true, force: true });
    }
  });

  it("omitting cwd is identical to passing process.cwd()", async () => {
    const A = baseProject();
    withComponent(A);
    try {
      const omitted = await inCwd(A, () => collectReview({ stages: ["design"] }));
      const explicit = await inCwd(A, () => collectReview({ cwd: A, stages: ["design"] }));
      assert.deepEqual(
        stage(omitted, "design")?.findings,
        stage(explicit, "design")?.findings,
        "the default must resolve to the process's own tree",
      );
    } finally {
      rmSync(A, { recursive: true, force: true });
    }
  });
});

describe("the standards stage passes cwd to all five runners", () => {
  // Deliberately a SOURCE-level check, and the docstring says why rather than pretending
  // otherwise: the standards stage's five rows report tool availability (lizard, jscpd, scc,
  // eslint, tsc), which two temp projects necessarily share, so a behavioural pair cannot
  // discriminate here without installing those tools. What CAN be asserted is that no runner is
  // invoked without the cwd `runStandardsGate` resolved — the exact omission that made
  // `runDesignGate` wrong.
  it("no checkStandards* call in standards-run.ts omits cwd", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(import.meta.dirname, "..", "src", "standards-run.ts"), "utf8");
    const calls = src.split(/checkStandards\w*\(/).slice(1);
    assert.equal(calls.length > 0, true, "sanity: the gate must invoke at least one runner");
    const missing = calls.filter((c) => !/\bcwd\b/.test(c.slice(0, 400)));
    assert.deepEqual(missing, [], "every standards runner must receive the governed cwd");
  });
});
