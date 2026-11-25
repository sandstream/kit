/**
 * `kit review gate` (src/review-gate.ts) and kit's reviewer App (scripts/agent-review-gate.mjs)
 * must not drift: the same fixtures go through both, and every difference fails.
 *
 * The script is protected (only the owner changes it), so it keeps its own copy of the logic; this
 * test is what holds the two together. The App approves exactly when the command says approve, and
 * its comment lists exactly the command's reasons, in the same order and words.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as shared from "./review-gate.js";
import type { CheckRun, GateInput } from "./review-gate.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Script {
  MAX_CHANGED_LINES: number;
  MAIN_CHECKS: string[];
  latestChecks(runs: CheckRun[]): CheckRun[];
  checksState(runs: CheckRun[]): shared.ChecksState;
  mainRed(runs: CheckRun[], names?: string[]): string[];
  decide(input: GateInput & { sha: string; fileCount: number }): { event: string; body: string };
}

const load = async () =>
  (await import(pathToFileURL(join(REPO_ROOT, "scripts", "agent-review-gate.mjs")).href)) as Script;

const r = (name: string, conclusion: string | null, status = "completed", at = "1"): CheckRun => ({
  name,
  status,
  conclusion,
  started_at: at,
});

const RUNS: CheckRun[][] = [
  [],
  [r("a", "success"), r("b", null, "in_progress")],
  [r("build", "failure", "completed", "1"), r("build", "success", "completed", "2")],
  [r("build", "success", "completed", "2"), r("build", "failure", "completed", "1")],
  [r("z", "failure"), r("a", "cancelled"), r("s", "skipped"), r("n", "neutral")],
  [r("build-and-test", "failure"), r("Scorecard", "failure"), r("x", "timed_out")],
  [
    r("build-and-test", "success", "completed", "3"),
    r("build-and-test", "failure", "completed", "4"),
  ],
];

const PROTECTED = [
  [],
  [{ path: ".github/workflows/ci.yml", classes: ["github"] }],
  Array.from({ length: 12 }, (_, i) => ({
    path: `src/secrets-${i}.ts`,
    classes: ["secrets", "github"],
  })),
];
const WIDE = [
  [],
  [
    { path: "src/config.ts", importers: 132 },
    { path: "src/a.ts", importers: 20 },
  ],
];
const MAIN = [
  null,
  { sha: "c".repeat(40), red: [] },
  { sha: "c".repeat(40), red: ["build-and-test"] },
];
const LINES = [0, 1500, 1501];

/** Every combination of the given value lists. */
function grid<T extends Record<string, readonly unknown[]>>(
  axes: T,
): { [K in keyof T]: T[K][number] }[] {
  let rows: Record<string, unknown>[] = [{}];
  for (const [key, values] of Object.entries(axes))
    rows = rows.flatMap((row) => values.map((value) => ({ ...row, [key]: value })));
  return rows as { [K in keyof T]: T[K][number] }[];
}

function fixtures(): GateInput[] {
  const checks = [
    { state: "green" as const, failed: [], total: 4 },
    { state: "failed" as const, failed: ["CI", "lint"], total: 4 },
  ];
  return grid({
    checks,
    protectedPaths: PROTECTED,
    widePaths: WIDE,
    main: MAIN,
    changedLines: LINES,
    truncated: [false, true],
  });
}

/** The reason bullets of the App's comment, or [] for an approval. */
function scriptReasons(body: string): string[] {
  const at = body.indexOf("**not approved**.\n\n- ");
  if (at < 0) return [];
  return body.slice(at + "**not approved**.\n\n- ".length).split("\n- ");
}

describe("review gate parity: the command and the App's script", () => {
  it("share the limits and the main-branch checks", async () => {
    const script = await load();
    assert.equal(shared.MAX_CHANGED_LINES, script.MAX_CHANGED_LINES);
    assert.deepEqual([...shared.MAIN_CHECKS], script.MAIN_CHECKS);
  });

  it("read check runs the same way", async () => {
    const script = await load();
    for (const runs of RUNS) {
      assert.deepEqual(shared.checksState(runs), script.checksState(runs));
      assert.deepEqual(shared.mainRed(runs), script.mainRed(runs));
      assert.deepEqual(shared.latestChecks(runs), script.latestChecks(runs));
    }
  });

  it("approve exactly when the App approves, with the App's reasons otherwise", async () => {
    const script = await load();
    const all = fixtures();
    assert.equal(all.length, 216, "the fixture grid covers every combination");
    for (const input of all) {
      const app = script.decide({ ...input, sha: "a".repeat(40), fileCount: 3 });
      const cmd = shared.decideGate(input);
      const label = JSON.stringify(input);
      assert.equal(app.event === "APPROVE", cmd.verdict === "approve", label);
      assert.deepEqual(
        scriptReasons(app.body),
        cmd.reasons.map((x) => x.text),
        label,
      );
    }
  });
});
