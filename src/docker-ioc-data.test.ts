import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DOCKER_IOCS } from "./docker-ioc-data.js";

describe("DOCKER_IOCS", () => {
  it("holds only values `docker image ls` can show, each with a cited source", () => {
    for (const ioc of DOCKER_IOCS) {
      if (ioc.kind === "digest") assert.match(ioc.value, /^sha256:[0-9a-f]{64}$/);
      else assert.match(ioc.value, /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/);
      assert.ok(ioc.source.length > 10 && ioc.incident && ioc.what, ioc.value);
    }
  });

  it("has no duplicate value", () => {
    const values = DOCKER_IOCS.map((i) => i.value);
    assert.equal(new Set(values).size, values.length);
  });
});
