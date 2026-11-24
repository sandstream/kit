/**
 * SECURITY.md ↔ package.json: the supported line is the one kit ships.
 *
 * GitHub shows SECURITY.md to anyone who reports a vulnerability. Its table said 6.12.x was the
 * supported line, and every version below 6.12 should upgrade to it, while kit shipped 7.5.0: the
 * table was last edited for 6.12.1 and nothing tied it to a release. A reporter on 7.x read that
 * their version was not listed. The first row that says "Yes" must name the major.minor line in
 * package.json, so a minor release fails this test until the table is updated with it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("SECURITY.md supported versions", () => {
  it("names the release line package.json ships as the supported one", () => {
    const { version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      version: string;
    };
    const line = version.split(".").slice(0, 2).join(".");
    const security = readFileSync(resolve(root, "SECURITY.md"), "utf8");
    const supported = security
      .split("\n")
      .find((row) => /^\|\s*[^|]+\|\s*Yes\b/.test(row))
      ?.split("|")[1]
      ?.trim();
    assert.equal(supported, `${line}.x`, "update the Supported versions table in SECURITY.md");
  });
});
