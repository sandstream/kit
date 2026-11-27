import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { detectFormat, inspectArchive } from "./release-archive.js";
import {
  makeTar,
  makeTarGz,
  makeZip,
  scratchDir,
  type FixtureEntry,
} from "./release-fixtures.test-support.js";

const scratch = scratchDir("kit-release-archive-");
after(scratch.remove);
const file = scratch.put;

const SAFE: FixtureEntry[] = [
  { name: "tool/", type: "5", mode: 0o755 },
  { name: "tool/bin", mode: 0o755, data: "\x7fELF" },
  { name: "tool/link", type: "2", link: "bin" },
];

describe("release archive members", () => {
  it("passes a tar.gz, a tar and a zip whose members stay in the tree", async () => {
    for (const [name, bytes] of [
      ["a.tar.gz", makeTarGz(SAFE)],
      ["a.tar", makeTar(SAFE)],
      ["a.zip", makeZip(SAFE)],
    ] as const) {
      const r = await inspectArchive(file(name, bytes));
      assert.equal(r.status, "pass", `${name}: ${r.detail}`);
      assert.equal(r.members.length, 3);
    }
  });

  it("fails each unsafe member, in tar and in zip", async () => {
    const unsafe: FixtureEntry[] = [
      { name: "/etc/cron.d/x" },
      { name: "a/../../b" },
      { name: "up", type: "2", link: "../../.ssh/authorized_keys" },
      { name: "abs", type: "2", link: "/etc/passwd" },
      { name: "suid", mode: 0o4755 },
    ];
    for (const [name, bytes] of [
      ["u.tgz", makeTarGz(unsafe)],
      ["u.zip", makeZip(unsafe)],
    ] as const) {
      const r = await inspectArchive(file(name, bytes));
      assert.equal(r.status, "fail");
      assert.equal(r.findings.length, 5, `${name}: ${r.findings.join(" | ")}`);
      assert.match(r.detail, /absolute path/);
      assert.match(r.detail, /"\.\." component/);
      assert.match(r.detail, /symlink out of the tree/);
      assert.match(r.detail, /setuid/);
    }
  });
});

describe("release archive formats", () => {
  it("passes a lone executable or a gzip'd single file, and does not call it an archive", async () => {
    const elf = await inspectArchive(file("tool", Buffer.from("\x7fELF\x02\x01\x01", "latin1")));
    assert.equal(elf.status, "pass");
    assert.match(elf.detail, /not an archive/);
    const gz = await inspectArchive(file("tool.gz", gzipSync(Buffer.from("\x7fELF", "latin1"))));
    assert.equal(gz.status, "pass");
  });

  it("is unverified for xz, bzip2, 7z and unknown bytes: never a pass", async () => {
    const xz = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 1, 2]);
    assert.equal((await inspectArchive(file("a.tar.xz", xz))).status, "unverified");
    const bz = Buffer.from("BZh91AY");
    assert.equal((await inspectArchive(file("a.tbz", bz))).status, "unverified");
    assert.equal((await inspectArchive(file("a.bin", Buffer.from("hello")))).status, "unverified");
    const sevenZip = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
    assert.deepEqual(detectFormat(sevenZip), { unreadable: "7z" });
  });

  it("fails a corrupt gzip", async () => {
    const gz = makeTarGz(SAFE);
    const broken = Buffer.concat([gz.subarray(0, 12), Buffer.alloc(40, 0xff)]);
    assert.equal((await inspectArchive(file("broken.tgz", broken))).status, "fail");
  });
});
