import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { inspectArchive } from "./release-archive.js";
import { listTar, TarFormatError } from "./release-archive-tar.js";
import { makeTar, makeTarGz, scratchDir } from "./release-fixtures.test-support.js";

const scratch = scratchDir("kit-release-tar-");
after(scratch.remove);

describe("tar member listing", () => {
  it("reads a long name from a pax header and judges that name, not the truncated one", async () => {
    const long = `${"d/".repeat(60)}../../../escape`;
    const r = await inspectArchive(scratch.put("long.tgz", makeTarGz([{ name: long }])));
    assert.equal(r.status, "fail");
    assert.equal(r.members[0]!.name, long);
  });

  it("reads modes, kinds and link targets, and skips data without keeping it", async () => {
    const tar = makeTar([
      { name: "bin/x", mode: 0o4755, data: "y".repeat(5000) },
      { name: "l", type: "2", link: "bin/x" },
    ]);
    const members = await listTar(Readable.from([tar]), 10);
    assert.deepEqual(
      members.map((m) => [m.name, m.kind, m.mode, m.link]),
      [
        ["bin/x", "file", 0o4755, undefined],
        ["l", "symlink", 0o644, "bin/x"],
      ],
    );
  });

  it("refuses a corrupt header or a truncated member", async () => {
    const tar = makeTar([{ name: "a", data: "x".repeat(2000) }]);
    const bad = Buffer.from(tar);
    bad[0] = 0x41; // the name changes, the checksum does not
    await assert.rejects(listTar(Readable.from([bad]), 10), TarFormatError);
    const cut = await inspectArchive(scratch.put("cut.tar", tar.subarray(0, 1024)));
    assert.equal(cut.status, "fail");
    assert.match(cut.detail, /ends inside a member/);
  });
});
