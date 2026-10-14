import { monkeyFinding, type MonkeyFinding, type MonkeySeverity } from "./monkey-test-contract.js";
import type { DesktopApp } from "./monkey-test-desktop-app.js";
import type { DesktopAction, DesktopConfig } from "./monkey-test-desktop-config.js";
import { TECHNICAL_ERROR_TEXT, type PageCheck } from "./monkey-test-desktop-page.js";

export interface DesktopInterruption {
  step: number;
  operation: string;
  action: DesktopAction;
  outcome: string;
  /** False when the app survived the action (a reload, or a close it declined). */
  restarted: boolean;
}

export interface DesktopRunResult {
  ok: boolean;
  seed: number;
  findings: MonkeyFinding[];
  steps: { name: string; status: "pass" | "fail" | "skip"; detail: string }[];
  interruptions: DesktopInterruption[];
  /** The click actions in order. The same seed against the same UI repeats them. */
  actions: string[];
  /** The temporary data folder, kept when the run found something. */
  keptDataDir?: string;
}

/** Small seeded generator (mulberry32). The in-page step uses the same algorithm. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ScheduledInterruption {
  step: number;
  operation: number;
  action: DesktopAction;
  /** Fraction of the delay range, so the schedule does not depend on the range. */
  delay: number;
}

/**
 * Which click steps become interruptions, and with which operation and action. It uses its
 * own stream of the run seed, so the click steps stay the same when the count changes.
 * Actions follow a seeded shuffle, so every action appears once before any repeats.
 */
export function interruptionSchedule(
  seed: number,
  options: {
    steps: number;
    interruptions: number;
    operations: number;
    actions: readonly DesktopAction[];
  },
): ScheduledInterruption[] {
  const random = seededRandom(seed ^ 0x9e3779b9);
  const count = Math.min(options.interruptions, Math.max(0, options.steps - 1));
  const steps = new Set<number>();
  while (steps.size < count) steps.add(1 + Math.floor(random() * (options.steps - 1)));
  const order = [...options.actions];
  for (let index = order.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [order[index], order[swap]] = [order[swap], order[index]];
  }
  return [...steps]
    .sort((a, b) => a - b)
    .map((step, index) => ({
      step,
      operation: Math.floor(random() * options.operations),
      action: order[index % order.length],
      delay: random(),
    }));
}

export interface RunState {
  root: string;
  config: DesktopConfig;
  seed: number;
  steps: number;
  interruptionCount: number;
  actions: readonly DesktopAction[];
  actionsFlag: string;
  delayMs: [number, number];
  pauseMs: number;
  result: DesktopRunResult;
  seen: Set<string>;
  tmp: string;
  dataDir: string;
  app: DesktopApp;
  realBefore: Record<string, string>;
  hidden: boolean;
  /** Whether the last bringBack started a new process. */
  restarted: boolean;
}

export const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
export const MAX_FINDINGS = 50;
const DEFAULT_CRASH = /panicked at|fatal runtime error|Segmentation fault|EXC_BAD_ACCESS|SIGABRT/;

const PAGE_FAILURES: Record<
  string,
  { severity: MonkeySeverity; area: MonkeyFinding["area"]; title: string; fix: string }
> = {
  pageerror: {
    severity: "high",
    area: "ux",
    title: "Page error",
    fix: "Fix the uncaught exception; the user sees a broken or frozen screen.",
  },
  unhandledrejection: {
    severity: "high",
    area: "ux",
    title: "Unhandled promise rejection",
    fix: "Handle the rejected call and tell the user what happened.",
  },
  console: {
    severity: "medium",
    area: "ux",
    title: "Console error",
    fix: "Fix the error, or handle it and show the user a clear message.",
  },
  alert: {
    severity: "medium",
    area: "ux",
    title: "Native alert dialog",
    fix: "Show the message in the app's own UI.",
  },
  "fatal-text": {
    severity: "high",
    area: "ux",
    title: "Fatal UI copy placeholder",
    fix: "Render a real empty or error state instead of a runtime placeholder.",
  },
  blank: {
    severity: "critical",
    area: "ux",
    title: "Blank window",
    fix: "Keep a visible state after every action; catch render errors.",
  },
  xss: {
    severity: "critical",
    area: "security",
    title: "Input ran as script (XSS)",
    fix: "Render user text as text; never insert it as HTML.",
  },
  "no-controls": {
    severity: "high",
    area: "ux",
    title: "No usable control left",
    fix: "Every state needs a way forward or back.",
  },
};

function repro(state: RunState, detail: string): string {
  return `kit monkey-test desktop --seed ${state.seed} --steps ${state.steps} --interruptions ${state.interruptionCount}${state.actionsFlag}; ${detail}`;
}

export function report(
  state: RunState,
  finding: {
    severity: MonkeySeverity;
    area: MonkeyFinding["area"];
    title: string;
    route: string;
    detail: string;
    fix: string;
    file?: string;
    /** Findings that belong to one interruption repeat per interruption; others once per cause. */
    perRoute?: boolean;
  },
): void {
  const cause = finding.detail.split(" | last steps")[0];
  const key = `${finding.title}|${cause}${finding.perRoute ? `|${finding.route}` : ""}`;
  if (state.seen.has(key) || state.result.findings.length >= MAX_FINDINGS) return;
  state.seen.add(key);
  state.result.findings.push(
    monkeyFinding({
      severity: finding.severity,
      area: finding.area,
      title: finding.title,
      role: "desktop",
      route: finding.route,
      repro: repro(state, finding.detail),
      file: finding.file,
      fix: finding.fix,
    }),
  );
}

export function recordCheck(state: RunState, check: PageCheck, route: string): void {
  state.hidden ||= check.hidden;
  if (check.action) state.result.actions.push(check.action);
  const trail = check.last.join(" -> ");
  for (const failure of check.fail) {
    const kind = PAGE_FAILURES[failure.kind] ?? PAGE_FAILURES.pageerror;
    report(state, { ...kind, route, detail: `${failure.message} | last steps: ${trail}` });
  }
  for (const text of check.errText.filter((entry) => TECHNICAL_ERROR_TEXT.test(entry))) {
    report(state, {
      severity: "medium",
      area: "ux",
      title: "Technical error text shown to the user",
      route,
      detail: `${text} | last steps: ${trail}`,
      fix: "Map the error to a message that says what happened and what to do.",
    });
  }
  for (const html of check.unnamed) {
    report(state, {
      severity: "medium",
      area: "a11y",
      title: "Unlabeled interactive control",
      route: "*",
      detail: html,
      fix: "Add visible text or an aria-label that says what the control does.",
    });
  }
}

export function scanLog(state: RunState, route: string): void {
  const patterns = [DEFAULT_CRASH, ...state.config.logCrashPatterns.map((p) => new RegExp(p))];
  for (const line of state.app.newLog().split("\n")) {
    if (!patterns.some((pattern) => pattern.test(line))) continue;
    report(state, {
      severity: "critical",
      area: "ux",
      title: "App log shows a crash",
      route,
      detail: line.trim().slice(0, 300),
      fix: "Fix the crash; a desktop app must survive every user action and restart.",
    });
  }
}
