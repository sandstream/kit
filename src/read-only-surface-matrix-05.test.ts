import { describe, it } from "node:test";
import { runDispatchShard } from "./read-only-surface-matrix-fixture.js";

describe("read-only CLI dispatch matrix shard 5/8", () => {
  for (const mode of ["env", "flag"] as const) {
    it(
      `blocks every mutation via ${mode === "env" ? "KIT_READ_ONLY" : "--read-only"}`,
      { timeout: 120_000 },
      () => runDispatchShard(4, mode),
    );
  }
});
