import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
  MonkeyFinding,
  MonkeyRunOptions,
  MonkeyRunResult,
  MonkeyTestPlan,
} from "./monkey-test-contract.js";
import { expectedReasonState, runnerEnvironment } from "./monkey-test-runner-env.js";
import { MonkeyProcessScope } from "./monkey-test-runner-processes.js";
import { buildMonkeyTestPlan } from "./monkey-test-plan.js";

export interface RunContext {
  root: string;
  options: MonkeyRunOptions;
  plan: MonkeyTestPlan;
  findings: MonkeyFinding[];
  steps: MonkeyRunResult["steps"];
  expectedReasonRaw?: string;
  expectedReason?: string;
  hasExpectedReason: boolean;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  processes: MonkeyProcessScope;
}

export async function createRunContext(
  cwd: string,
  options: MonkeyRunOptions,
): Promise<RunContext> {
  const root = resolve(cwd);
  const plan = await buildMonkeyTestPlan(root, { envCommand: options.envCommand });
  const expectedReason = expectedReasonState(options);
  const runId = randomUUID();
  return {
    root,
    options,
    plan,
    findings: [],
    steps: [],
    expectedReasonRaw: expectedReason.raw,
    expectedReason: expectedReason.redacted,
    hasExpectedReason: expectedReason.valid,
    timeoutMs: options.timeoutMs ?? 120_000,
    env: runnerEnvironment(options, runId),
    processes: new MonkeyProcessScope(),
  };
}
