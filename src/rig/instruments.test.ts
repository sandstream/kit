import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RunMark } from "./findings.js";
import { instrumentsOf, instrumentWarnings } from "./instruments.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER = `sha256:${"b".repeat(64)}`;

const mark = (run: string, config: string, digest?: string): RunMark => ({
  run,
  config,
  target: "d1",
  model: "some-model",
  model_version: "latest",
  date: "2026-10-31",
  ...(digest ? { model_digest: digest } : {}),
});

describe("instruments", () => {
  it("lists each (config, model, version, digest) once with its run count, sorted", () => {
    const runs = [mark("r1", "B"), mark("r2", "A", OTHER), mark("r1", "A", DIGEST)];
    runs.push({ ...mark("r1", "A", DIGEST), target: "c1" });
    assert.deepEqual(instrumentsOf(runs), [
      { config: "A", model: "some-model", model_version: "latest", model_digest: DIGEST, runs: 1 },
      { config: "A", model: "some-model", model_version: "latest", model_digest: OTHER, runs: 1 },
      { config: "B", model: "some-model", model_version: "latest", runs: 1 },
    ]);
  });

  it("warns when one label covers two digests, or digested and undigested runs", () => {
    const split = instrumentWarnings(
      instrumentsOf([mark("r1", "A", DIGEST), mark("r2", "A", OTHER)]),
    );
    assert.equal(split.length, 1);
    assert.match(
      split[0],
      /config A: some-model latest was declared with 2 different model_digest/,
    );
    const mixed = instrumentWarnings(instrumentsOf([mark("r1", "A", DIGEST), mark("r2", "A")]));
    assert.equal(mixed.length, 1);
    assert.match(mixed[0], /1 run\(s\) with no model_digest/);
    assert.deepEqual(instrumentWarnings(instrumentsOf([mark("r1", "A"), mark("r2", "A")])), []);
  });
});
