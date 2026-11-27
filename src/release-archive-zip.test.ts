import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { listZip, ZipFormatError } from "./release-archive-zip.js";
import { makeZip, scratchDir } from "./release-fixtures.test-support.js";

const scratch = scratchDir("kit-release-zip-");
after(scratch.remove);

describe("zip member listing", () => {
  it("reads Unix modes and inflates a symlink's target from the central directory", () => {
    const zip = makeZip([
      { name: "tool", mode: 0o6755, data: "\x7fELF" },
      { name: "link", type: "2", link: "../../etc/passwd" },
      { name: "dir/", type: "5", mode: 0o755 },
    ]);
    const members = listZip(scratch.put("a.zip", zip), 10);
    assert.deepEqual(
      members.map((m) => [m.name, m.kind, m.mode, m.link]),
      [
        ["tool", "file", 0o6755, undefined],
        ["link", "symlink", 0o644, "../../etc/passwd"],
        ["dir/", "dir", 0o755, undefined],
      ],
    );
  });

  it("refuses a file with no end record, and a zip64 archive", () => {
    assert.throws(
      () => listZip(scratch.put("no.zip", Buffer.from("PK\x03\x04 nothing")), 10),
      ZipFormatError,
    );
    const zip = makeZip([{ name: "a" }]);
    zip.writeUInt16LE(0xffff, zip.length - 22 + 10);
    assert.throws(() => listZip(scratch.put("z64.zip", zip), 10), /zip64/);
  });
});
