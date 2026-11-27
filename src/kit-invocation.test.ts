import { it } from "node:test";
import assert from "node:assert/strict";
import { kitGateInvocation, kitSubcommandInvocation } from "./kit-invocation.js";

it("names the gate subcommand on the kit command line", () => {
  assert.match(kitGateInvocation(), / gate-bash$/);
  assert.match(kitSubcommandInvocation("gate-env"), / gate-env$/);
});
