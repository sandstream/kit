import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MONKEY_ROLES,
  prioritizeFindings,
  validateExpectedFindings,
  validateMoneyFlowConfig,
} from "./monkey-test-contract.js";

describe("monkey-test contract", () => {
  it("keeps kiosk staff distinct and prioritizes release blockers", () => {
    assert.deepEqual(
      MONKEY_ROLES.map(({ id }) => id),
      ["public", "customer", "staff", "owner", "superadmin"],
    );
    const findings = prioritizeFindings([
      {
        severity: "low",
        area: "ux",
        title: "copy",
        role: "public",
        route: "/",
        repro: "r",
        fix: "f",
      },
      {
        severity: "critical",
        area: "authz",
        title: "leak",
        role: "staff",
        route: "/admin",
        repro: "r",
        fix: "f",
      },
    ]);
    assert.equal(findings[0].title, "leak");
  });

  it("requires exact expected findings and complete sandbox money evidence", () => {
    assert.throws(
      () => validateExpectedFindings([{ title: "known", role: "public", route: "/" }]),
      /reason/,
    );
    const flow = validateMoneyFlowConfig({
      MONKEY_PAYMENT_MODE: "sandbox",
      MONKEY_PAYMENT_ACTION: "cancel",
      MONKEY_MONEY_ROUTE: "/shop",
      MONKEY_ADD_TO_CART: "#add",
      MONKEY_CHECKOUT: "#checkout",
      MONKEY_PAYMENT_SHELL: "#payment",
      MONKEY_SANDBOX_INDICATOR: "#sandbox",
      MONKEY_CANCEL_PAYMENT: "#cancel",
      MONKEY_CANCELLED_STATE: "#cancelled",
    });
    assert.equal(flow.action, "cancel");
    assert.equal(flow.mode, "sandbox");
  });
});
