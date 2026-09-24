import { it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createProjectMapper, parseProjectMappings } from "./remap.js";

it("maps longest literal prefixes, including Windows sources and local relative destinations", () => {
  const map = createProjectMapper({
    projectMappings: [
      { from: "/old/repo_%/", to: "local" },
      { from: "/old/repo_%/nested", to: "second" },
      { from: "C:\\Users\\test\\repo", to: "windows" },
    ],
  });
  assert.equal(map("/old/repo_%/src"), resolve("local/src"));
  assert.equal(map("/old/repo_%/nested/src"), resolve("second/src"));
  assert.equal(map("C:\\Users\\test\\repo\\src"), resolve("windows/src"));
  assert.equal(map("/old/repo_%extra"), undefined);
  assert.equal(map("/old/repo_X"), undefined);
  assert.equal(map(undefined), undefined);
  const roots = createProjectMapper({
    projectMappings: parseProjectMappings([
      { from: "C:\\", to: "drive" },
      { from: "\\\\server\\share\\", to: "network" },
    ]),
  });
  assert.equal(roots("C:\\repo\\src"), resolve("drive/repo/src"));
  assert.equal(roots("\\\\server\\share\\repo"), resolve("network/repo"));
});

it("refuses malformed or conflicting mappings before import", () => {
  for (const value of [
    null,
    {},
    [null],
    [{ from: "relative", to: "/local" }],
    [{ from: "/old", to: "" }],
  ]) {
    assert.throws(() => parseProjectMappings(value));
  }
  assert.throws(
    () =>
      parseProjectMappings([
        { from: "/old/", to: "one" },
        { from: "/old", to: "two" },
      ]),
    /duplicate/,
  );
  assert.throws(() => createProjectMapper({ remapProject: "" }), /nonempty/);
  assert.throws(
    () =>
      createProjectMapper({
        remapProject: "local",
        projectMappings: [{ from: "/old", to: "local" }],
      }),
    /not both/,
  );
});
