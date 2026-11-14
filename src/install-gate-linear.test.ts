import { it } from "node:test";
import assert from "node:assert/strict";
import { parseInstallCommand } from "./install-gate.js";

// Moved out of install-gate.test.ts's frozen describe block when the wall-clock bound became a
// growth bound.
it("nested-command queue is linear on many duplicate nested items (no O(N^2) shift)", () => {
  // `queue.shift()` on a large array was O(N); N identical `$(…)` items → O(N^2) (~4.5s at
  // 80k). A head cursor + push-dedup makes it linear.
  // Growth, not a wall-clock bound: 1500 ms at 80k failed twice on a loaded Windows runner at
  // ~1575 ms while linear. Quadrupling N quadruples a linear parse and multiplies a quadratic one
  // by sixteen; the best of two runs at each size keeps one slow run from deciding.
  const time = (n: number) => {
    let best = Infinity;
    for (let run = 0; run < 2; run++) {
      const start = process.hrtime.bigint();
      parseInstallCommand("$(npm i evil) ".repeat(n));
      best = Math.min(best, Number(process.hrtime.bigint() - start) / 1e6);
    }
    return best;
  };
  const small = time(20000);
  const large = time(80000);
  assert.ok(large / small < 8, `4x input took ${(large / small).toFixed(1)}x as long — O(N^2)?`);
  const p = parseInstallCommand("$(npm i evil) ".repeat(80000));
  assert.equal(p.isInstall, true); // fail-closed: unresolvable indirection
});
