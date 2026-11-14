import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { inspectNpmTarball } from "./npm-artifact-archive.js";

type Entry = { path: string; body?: string; dir?: boolean };

function block(entry: Entry): Buffer {
  const body = Buffer.from(entry.body ?? "");
  const header = Buffer.alloc(512);
  header.write(entry.path, 0, "utf8");
  header.write("0000644\0", 100, "latin1");
  header.write("0000000\0", 108, "latin1");
  header.write("0000000\0", 116, "latin1");
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, "latin1");
  header.write("00000000000\0", 136, "latin1");
  header.write(entry.dir ? "5" : "0", 156, "latin1");
  header.write("ustar\0" + "00", 257, "latin1");
  header.write("        ", 148, "latin1");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding]);
}

function archive(entries: Entry[]): Buffer {
  const tar = Buffer.concat([...entries.map(block), Buffer.alloc(1024)]);
  return gzipSync(tar);
}

const manifest: Entry = { path: "package/package.json", body: '{"name":"a","version":"1.0.0"}' };
const reason = (entries: Entry[]) => {
  const result = inspectNpmTarball(archive(entries));
  return result.status === "verified" ? "verified" : result.reason;
};

describe("inspectNpmTarball path folding", () => {
  it("verifies a plain archive built by the test helper (control)", () => {
    assert.equal(reason([manifest, { path: "package/index.js", body: "1" }]), "verified");
  });

  it("refuses two files whose names differ only in case", () => {
    const entries = [manifest, { path: "package/index.js" }, { path: "package/Index.js" }];
    assert.equal(reason(entries), "path-conflict");
  });

  it("refuses a second manifest spelled in another case", () => {
    const entries = [manifest, { path: "package/Package.json", body: '{"name":"b"}' }];
    assert.equal(reason(entries), "path-conflict");
  });

  it("refuses names that differ only in Unicode normalization form", () => {
    const composed = "package/café.js";
    const decomposed = "package/café.js";
    assert.equal(reason([manifest, { path: composed }, { path: decomposed }]), "path-conflict");
  });

  it("refuses a file and a directory that collide after case folding", () => {
    const entries = [manifest, { path: "package/lib", body: "x" }, { path: "package/LIB/a.js" }];
    assert.equal(reason(entries), "path-conflict");
  });

  it("still reports an exact duplicate as a duplicate", () => {
    const entries = [manifest, { path: "package/a.js" }, { path: "package/a.js" }];
    assert.equal(reason(entries), "path-duplicate");
  });
});
