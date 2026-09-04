import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { monkeySpec } from "./monkey-test-harness-spec.js";

describe("generated monkey Playwright spec", () => {
  it("contains both viewports, every role, and real sandbox payment assertions", () => {
    const spec = monkeySpec("// generated\n");
    for (const role of ["public", "customer", "staff", "owner", "superadmin"]) {
      assert.match(spec, new RegExp(`\\{ id: "${role}"`));
    }
    assert.match(spec, /route crawl/);
    assert.match(spec, /validateMoneyFlowConfig/);
    assert.match(spec, /MONKEY_SANDBOX_INDICATOR/);
    assert.match(spec, /MONKEY_SKIP_MONEY_FLOW requires MONKEY_EXPECTED_REASON/);
    assert.match(spec, /Live payment env keys are not allowed/);
  });
});
