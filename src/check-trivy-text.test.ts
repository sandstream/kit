import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeTrivyFsResult } from "./check-trivy-text.js";

// The check is called "trivy container scan" for historical reasons, but it runs `trivy fs` on the
// project files when a Dockerfile exists. It never looks at a built image, and its text must not
// let a green row read as "the container is clean".
describe("describeTrivyFsResult", () => {
  it("says a clean result is about the project files and names how to scan the image", () => {
    const got = describeTrivyFsResult(0);
    assert.equal(got.status, "pass");
    assert.match(got.detail, /project files/);
    assert.match(got.detail, /built image is not scanned/);
    assert.match(got.detail, /\[scan\]\.images/);
  });

  it("counts the findings and says they are in the project files", () => {
    const got = describeTrivyFsResult(3);
    assert.equal(got.status, "fail");
    assert.match(got.detail, /3 high\/critical/);
    assert.match(got.detail, /project files/);
    assert.doesNotMatch(got.detail, /in container$/);
  });
});
