import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { detectFormat, inspectArchive } from "./release-archive.js";
import { memberFindings } from "./release-archive-member.js";
import { makeTar, makeTarGz, makeZip, type FixtureEntry } from "./release-fixtures.test-support.js";

let dir: string;
before(() => (dir = mkdtempSync(join(tmpdir(), "kit-release-archive-"))));
after(() => rmSync(dir, { recursive: true, force: true }));

function file(name: string, bytes: Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

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

  it("reads a long name from a pax header and judges that name, not the truncated one", async () => {
    const long = `${"d/".repeat(60)}../../../escape`;
    const r = await inspectArchive(file("long.tgz", makeTarGz([{ name: long }])));
    assert.equal(r.status, "fail");
    assert.equal(r.members[0]!.name, long);
  });

  it("fails a device entry, a hard link out of the tree, and a Windows-style escape", () => {
    assert.match(memberFindings({ name: "dev", kind: "special", mode: 0 }).join(), /special/);
    assert.match(
      memberFindings({ name: "h", kind: "hardlink", mode: 0, link: "../x" }).join(),
      /hard link/,
    );
    assert.match(memberFindings({ name: "..\\..\\x.exe", kind: "file", mode: 0 }).join(), /"\.\."/);
    assert.match(
      memberFindings({ name: "C:\\Windows\\x", kind: "file", mode: 0 }).join(),
      /absolute/,
    );
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
    assert.equal(
      (await inspectArchive(file("a.tbz", Buffer.from("BZh91AY")))).status,
      "unverified",
    );
    assert.equal((await inspectArchive(file("a.bin", Buffer.from("hello")))).status, "unverified");
    assert.deepEqual(detectFormat(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])), {
      unreadable: "7z",
    });
  });

  it("fails a tar with a corrupt header or a truncated member, and a corrupt gzip", async () => {
    const tar = makeTar([{ name: "a", data: "x".repeat(2000) }]);
    const bad = Buffer.from(tar);
    bad[0] = 0x41; // the name changes, the checksum does not
    assert.equal((await inspectArchive(file("bad.tar", bad))).status, "fail");
    const cut = tar.subarray(0, 1024);
    assert.match((await inspectArchive(file("cut.tar", cut))).detail, /ends inside a member/);
    const gz = makeTarGz(SAFE);
    const broken = Buffer.concat([gz.subarray(0, 12), Buffer.alloc(40, 0xff)]);
    assert.equal((await inspectArchive(file("broken.tgz", broken))).status, "fail");
  });
});
