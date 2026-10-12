import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "..", ".github", "workflows");

/** A hung runner otherwise burns the 360 minute default and blocks the merge queue. */
describe("every workflow job bounds its runtime", () => {
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".yml"))) {
    it(file, () => {
      const lines = readFileSync(join(dir, file), "utf8").split("\n");
      const start = lines.findIndex((l) => l === "jobs:");
      assert.ok(start >= 0, "no jobs block");
      const jobs: { name: string; hasTimeout: boolean }[] = [];
      for (const line of lines.slice(start + 1)) {
        const job = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
        if (job) jobs.push({ name: job[1], hasTimeout: false });
        else if (/^ {4}timeout-minutes:\s*\d+/.test(line) && jobs.length) {
          jobs[jobs.length - 1].hasTimeout = true;
        }
      }
      const missing = jobs.filter((j) => !j.hasTimeout).map((j) => j.name);
      assert.deepEqual(missing, [], `jobs without timeout-minutes: ${missing.join(", ")}`);
    });
  }
});
