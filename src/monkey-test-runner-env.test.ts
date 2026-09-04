import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  expectedReasonState,
  parseEnvOutput,
  runnerEnvironment,
} from "./monkey-test-runner-env.js";

describe("monkey-test runner environment", () => {
  it("parses JSON and dotenv output without accepting invalid keys", () => {
    assert.deepEqual(parseEnvOutput('{"TOKEN":"value","PORT":42,"DROP":false}'), {
      TOKEN: "value",
      PORT: "42",
    });
    assert.deepEqual(parseEnvOutput('TOKEN="quoted"\nBAD KEY=value\n# comment\n'), {
      TOKEN: "quoted",
    });
  });

  it("binds evidence to a run id and requires a specific skip reason", () => {
    const env = runnerEnvironment({ linkDepth: 4 }, "run-123");
    assert.equal(env.MONKEY_RUN_ID, "run-123");
    assert.equal(env.MONKEY_LINK_DEPTH, "4");
    assert.equal(expectedReasonState({ expectedReason: "too short" }).valid, false);
    assert.equal(
      expectedReasonState({ expectedReason: "accepted until ticket 42 closes" }).valid,
      true,
    );
  });
});
