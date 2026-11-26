/** Which file a bare command name runs: POSIX PATH order and Windows PATHEXT, pure, every platform. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import { findOnPath, pathCandidates } from "./path-lookup.js";

describe("PATH lookup", () => {
  it("POSIX: PATH order, and a relative `.` entry resolves against cwd (the ./op shadow)", () => {
    const c = pathCandidates("op", { PATH: ".:/usr/local/bin:/usr/bin" }, "linux", "/proj");
    assert.deepEqual(c, ["/proj/op", "/usr/local/bin/op", "/usr/bin/op"]);
    const hit = findOnPath("op", { PATH: "/a:/b" }, "linux", "/proj", (p) => p === "/b/op");
    assert.equal(hit, posix.join("/b", "op"));
    assert.equal(
      findOnPath("./op", { PATH: "/a" }, "linux", "/proj", () => true),
      null,
    );
  });

  it("win32: current directory first, then PATH, each with every PATHEXT extension", () => {
    const env = { Path: "C:\\tools;C:\\bin", PATHEXT: ".EXE;.CMD" };
    assert.deepEqual(pathCandidates("op", env, "win32", "C:\\proj"), [
      "C:\\proj\\op.exe",
      "C:\\proj\\op.cmd",
      "C:\\tools\\op.exe",
      "C:\\tools\\op.cmd",
      "C:\\bin\\op.exe",
      "C:\\bin\\op.cmd",
    ]);
    const hit = findOnPath("op", env, "win32", "C:\\proj", (p) => p === "C:\\bin\\op.cmd");
    assert.equal(hit, win32.join("C:\\bin", "op.cmd"));
    // A name that already carries an extension is not extended again.
    assert.deepEqual(pathCandidates("op.exe", { Path: "C:\\t" }, "win32", "C:\\p"), [
      "C:\\p\\op.exe",
      "C:\\t\\op.exe",
    ]);
  });
});
