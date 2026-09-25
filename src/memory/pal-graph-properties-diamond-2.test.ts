import { it } from "node:test";
import { checkDiamondResolution } from "./pal-graph-properties.test-support.js";

it("diamond resolution cannot hide a delayed branch and converges after explicit resolution (2/2)", () => {
  checkDiamondResolution(20260915, 10);
});
