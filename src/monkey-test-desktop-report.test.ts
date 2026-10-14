import assert from "node:assert/strict";
import { it } from "node:test";
import { validateDesktopConfig } from "./monkey-test-desktop-config.js";
import type { PageCheck } from "./monkey-test-desktop-page.js";
import {
  MAX_FINDINGS,
  interruptionSchedule,
  recordCheck,
  report,
  scanLog,
  seededRandom,
  sleep,
  type RunState,
} from "./monkey-test-desktop-report.js";

function makeState(log = "", crashPatterns: string[] = []): RunState {
  const config = validateDesktopConfig({
    startCommand: "x",
    dataDirEnv: "A_DIR",
    hookDirEnv: "B_DIR",
    realDataDirs: ["/abs"],
    dataFiles: ["*"],
    records: "return [];",
    operations: [{ name: "op", start: "s", outcome: "o" }],
    logCrashPatterns: crashPatterns,
  });
  return {
    root: "/r",
    config,
    seed: 42,
    steps: 10,
    interruptionCount: 2,
    actions: ["kill"],
    actionsFlag: " --actions kill",
    delayMs: [0, 1],
    pauseMs: 0,
    result: {
      ok: true,
      seed: 42,
      findings: [],
      steps: [],
      interruptions: [],
      actions: [],
    },
    seen: new Set(),
    tmp: "/t",
    dataDir: "/d",
    app: { newLog: () => log } as unknown as RunState["app"],
    realBefore: {},
    hidden: false,
    restarted: false,
  };
}

function check(partial: Partial<PageCheck>): PageCheck {
  return { fail: [], errText: [], unnamed: [], last: [], hidden: false, ...partial };
}

const FINDING = {
  severity: "high" as const,
  area: "ux" as const,
  title: "T",
  route: "r1",
  detail: "cause | last steps: a",
  fix: "f",
};

it("seededRandom repeats per seed and stays in [0, 1)", () => {
  const a = seededRandom(5);
  const b = seededRandom(5);
  const values = Array.from({ length: 50 }, () => a());
  assert.deepEqual(
    values,
    Array.from({ length: 50 }, () => b()),
  );
  assert.ok(values.every((value) => value >= 0 && value < 1));
  assert.notEqual(seededRandom(6)(), values[0]);
});

it("schedule is deterministic and sorted by step", () => {
  const options = {
    steps: 20,
    interruptions: 5,
    operations: 3,
    actions: ["kill", "quit"] as const,
  };
  const first = interruptionSchedule(9, options);
  assert.deepEqual(first, interruptionSchedule(9, options));
  assert.equal(first.length, 5);
  const steps = first.map((entry) => entry.step);
  assert.deepEqual(
    steps,
    [...steps].sort((x, y) => x - y),
  );
  assert.equal(new Set(steps).size, 5);
  assert.ok(steps.every((step) => step >= 1 && step <= 19));
  assert.ok(first.every((entry) => entry.operation >= 0 && entry.operation < 3));
});

it("schedule uses every action once before repeating", () => {
  const actions = ["close-window", "quit", "kill", "reload", "restart"] as const;
  const plan = interruptionSchedule(3, { steps: 50, interruptions: 5, operations: 1, actions });
  assert.deepEqual(plan.map((entry) => entry.action).sort(), [...actions].sort());
});

it("schedule caps the count at steps - 1 and never goes negative", () => {
  const actions = ["kill"] as const;
  const capped = interruptionSchedule(1, { steps: 4, interruptions: 99, operations: 1, actions });
  assert.deepEqual(
    capped.map((entry) => entry.step),
    [1, 2, 3],
  );
  assert.deepEqual(
    interruptionSchedule(1, { steps: 0, interruptions: 3, operations: 1, actions }),
    [],
  );
});

it("sleep resolves after the delay", async () => {
  const start = Date.now();
  await sleep(20);
  assert.ok(Date.now() - start >= 15);
});

it("report adds a finding with a repro line", () => {
  const state = makeState();
  report(state, FINDING);
  assert.equal(state.result.findings.length, 1);
  const [finding] = state.result.findings;
  assert.equal(finding.role, "desktop");
  assert.equal(finding.route, "r1");
  assert.match(
    finding.repro,
    /^kit monkey-test desktop --seed 42 --steps 10 --interruptions 2 --actions kill; cause/,
  );
});

it("report dedupes by title and cause, ignoring the step trail", () => {
  const state = makeState();
  report(state, FINDING);
  report(state, { ...FINDING, route: "r2", detail: "cause | last steps: other" });
  assert.equal(state.result.findings.length, 1);
  report(state, { ...FINDING, detail: "different cause" });
  assert.equal(state.result.findings.length, 2);
});

it("report repeats per route when perRoute is set", () => {
  const state = makeState();
  report(state, { ...FINDING, perRoute: true });
  report(state, { ...FINDING, perRoute: true, route: "r2" });
  report(state, { ...FINDING, perRoute: true, route: "r2" });
  assert.equal(state.result.findings.length, 2);
});

it("report stops at MAX_FINDINGS", () => {
  const state = makeState();
  for (let index = 0; index < MAX_FINDINGS + 10; index++) {
    report(state, { ...FINDING, detail: `cause ${index}` });
  }
  assert.equal(state.result.findings.length, MAX_FINDINGS);
});

it("recordCheck maps failure kinds and records the action and hidden flag", () => {
  const state = makeState();
  recordCheck(
    state,
    check({
      fail: [
        { kind: "blank", message: "no text" },
        { kind: "xss", message: "ran" },
        { kind: "unknown-kind", message: "weird" },
      ],
      last: ["a", "b"],
      action: "click [button] Go",
      hidden: true,
    }),
    "op1",
  );
  const titles = state.result.findings.map((finding) => finding.title);
  assert.deepEqual(titles, ["Blank window", "Input ran as script (XSS)", "Page error"]);
  assert.equal(state.result.findings[0].severity, "critical");
  assert.match(state.result.findings[0].repro, /no text \| last steps: a -> b/);
  assert.deepEqual(state.result.actions, ["click [button] Go"]);
  assert.equal(state.hidden, true);
});

it("recordCheck keeps hidden once set", () => {
  const state = makeState();
  recordCheck(state, check({ hidden: true }), "r");
  recordCheck(state, check({ hidden: false }), "r");
  assert.equal(state.hidden, true);
});

it("recordCheck reports only technical error text", () => {
  const state = makeState();
  recordCheck(state, check({ errText: ["Could not save", "missing field `id`"] }), "r");
  assert.equal(state.result.findings.length, 1);
  assert.equal(state.result.findings[0].title, "Technical error text shown to the user");
});

it("recordCheck reports unlabeled controls on every route", () => {
  const state = makeState();
  recordCheck(state, check({ unnamed: ["<button></button>"] }), "op1");
  assert.equal(state.result.findings[0].area, "a11y");
  assert.equal(state.result.findings[0].route, "*");
});

it("scanLog flags default crash lines and trims them", () => {
  const state = makeState("ok line\n  thread 'main' panicked at lib.rs:1  \nfine\n");
  scanLog(state, "op1");
  assert.equal(state.result.findings.length, 1);
  assert.equal(state.result.findings[0].severity, "critical");
  assert.match(state.result.findings[0].repro, /panicked at lib\.rs:1$/);
});

it("scanLog uses the configured crash patterns", () => {
  const state = makeState("custom BOOM happened\nnormal\n", ["BOOM\\d*"]);
  scanLog(state, "op1");
  assert.equal(state.result.findings.length, 1);
  assert.match(state.result.findings[0].repro, /custom BOOM happened/);
});

it("scanLog reports nothing for a clean log", () => {
  const state = makeState("all good\nstarted\n");
  scanLog(state, "op1");
  assert.deepEqual(state.result.findings, []);
});
