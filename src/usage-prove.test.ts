/**
 * The negative controls, asserted against the real CLI.
 *
 * `controlHarmlessCommandAllowed` is not a courtesy test: it is what makes the refusal mean
 * something. A gate that refuses everything would pass the first control while being an outage, so
 * the pair is asserted together or neither claim holds.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { controlUnverifiableInstall, controlHarmlessCommandAllowed } from "./usage-prove.js";

describe("the negative controls", () => {
  it("refuse an install whose target cannot be resolved", () => {
    const ctl = controlUnverifiableInstall();
    assert.equal(ctl.verdict, "refused", ctl.observed);
    assert.equal(ctl.ok, true);
  });

  it("and still allow a command that installs nothing — or the first control proves nothing", () => {
    const ctl = controlHarmlessCommandAllowed();
    assert.equal(ctl.verdict, "allowed", ctl.observed);
    assert.equal(ctl.ok, true);
  });
});
