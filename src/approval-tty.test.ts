import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

// kit-research out-of-loop-durable-agents-vs-kit-approvals: the approval prompt read its answer
// from stdin with no terminal check, so `echo yes | kit …` was the agent approving itself.
const APPROVAL = pathToFileURL(join(process.cwd(), "src", "approval.ts")).href;
const TSX = import.meta.resolve("tsx");

function approveWithPipedStdin(input: string, env: NodeJS.ProcessEnv) {
  const script = `
    const { requestApproval } = await import(${JSON.stringify(APPROVAL)});
    const ok = await requestApproval(
      { approval: { destructive_operations: ["deploy"], production_writes: true } },
      { operation: "deploy", environment: "prod", reason: "fixture" },
    );
    process.stdout.write("\\nRESULT=" + ok + "\\n");
  `;
  return spawnSync(process.execPath, ["--import", TSX, "--input-type=module", "-e", script], {
    input,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
}

describe("requestApproval needs a person at a terminal", () => {
  for (const [label, ci] of [
    ["no CI variable", undefined],
    ["CI=1", "1"],
  ] as const) {
    it(`denies a piped "yes" (${label})`, () => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.CI;
      delete env.KIT_NON_INTERACTIVE;
      if (ci !== undefined) env.CI = ci;
      const result = approveWithPipedStdin("yes\n", env);
      assert.ifError(result.error);
      assert.match(result.stdout, /RESULT=false/, result.stdout + result.stderr);
    });
  }
});
