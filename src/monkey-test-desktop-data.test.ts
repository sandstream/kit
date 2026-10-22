import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { checkDataFiles, fingerprintDirs, matchesDataGlob } from "./monkey-test-desktop-data.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-desktop-data-"));
  for (const [name, text] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, text);
  }
  return dir;
}

function cleanup(dir: string): void {
  rmTemp(dir);
}

it("star matches inside one folder only", () => {
  assert.equal(matchesDataGlob("a.json", "*.json"), true);
  assert.equal(matchesDataGlob("dir/a.json", "*.json"), false);
  assert.equal(matchesDataGlob("dir/a.json", "dir/*.json"), true);
});

it("double star matches across folders, including none", () => {
  assert.equal(matchesDataGlob("a.json", "**/*.json"), true);
  assert.equal(matchesDataGlob("x/y/a.json", "**/*.json"), true);
  assert.equal(matchesDataGlob("x/y/a.txt", "**/*.json"), false);
  assert.equal(matchesDataGlob("x/y/z", "x/**"), true);
});

it("question mark matches one character and dots are literal", () => {
  assert.equal(matchesDataGlob("a1.json", "a?.json"), true);
  assert.equal(matchesDataGlob("a/.json", "a?.json"), false);
  assert.equal(matchesDataGlob("aXjson", "a.json"), false);
});

it("accepts valid json, jsonl, ndjson and toml files", () => {
  const dir = fixture({
    "a.json": '{"a":1}',
    "b.jsonl": '{"a":1}\n\n{"b":2}\n',
    "c.ndjson": '{"a":1}',
    "d.toml": 'key = "value"\n',
  });
  try {
    const result = checkDataFiles(dir, ["*"]);
    assert.equal(result.files.length, 4);
    assert.deepEqual(result.corrupt, []);
    assert.deepEqual(result.unchecked, []);
  } finally {
    cleanup(dir);
  }
});

it("reports torn, empty and invalid files as corrupt", () => {
  const dir = fixture({
    "torn.json": '{"a":',
    "empty.json": "  \n",
    "bad.jsonl": '{"a":1}\n{oops\n',
    "bad.toml": "key = = 1",
  });
  try {
    const result = checkDataFiles(dir, ["*"]);
    assert.deepEqual(result.corrupt.map((entry) => entry.file).sort(), [
      "bad.jsonl",
      "bad.toml",
      "empty.json",
      "torn.json",
    ]);
    assert.equal(result.corrupt.find((entry) => entry.file === "empty.json")?.error, "empty file");
  } finally {
    cleanup(dir);
  }
});

it("lists matched files of unknown type as unchecked", () => {
  const dir = fixture({ "notes.txt": "hello", "sub/data.json": "{}" });
  try {
    const result = checkDataFiles(dir, ["**/*"]);
    assert.deepEqual(result.unchecked, ["notes.txt"]);
    assert.deepEqual(result.files.sort(), ["notes.txt", "sub/data.json"]);
  } finally {
    cleanup(dir);
  }
});

it("only inspects files the globs match, and tolerates a missing folder", () => {
  const dir = fixture({ "keep.json": "{", "skip.json": "{" });
  try {
    assert.deepEqual(checkDataFiles(dir, ["keep.json"]).files, ["keep.json"]);
    assert.deepEqual(checkDataFiles(join(dir, "nope"), ["*"]).files, []);
  } finally {
    cleanup(dir);
  }
});

it("does not follow symlinks", () => {
  const dir = fixture({ "real/a.json": "{}" });
  try {
    symlinkSync(join(dir, "real"), join(dir, "link"), "dir");
    assert.deepEqual(checkDataFiles(dir, ["**/*.json"]).files, ["real/a.json"]);
  } finally {
    cleanup(dir);
  }
});

it("fingerprint marks a missing folder", () => {
  const prints = fingerprintDirs([join(tmpdir(), "kit-desktop-data-missing-xyz")], []);
  assert.deepEqual(Object.values(prints), ["missing"]);
});

it("fingerprint is stable, then changes when a file changes", () => {
  const dir = fixture({ "a.txt": "one" });
  try {
    const before = fingerprintDirs([dir], [])[dir];
    assert.equal(fingerprintDirs([dir], [])[dir], before);
    assert.match(before, /^a\.txt:3:/);
    writeFileSync(join(dir, "a.txt"), "three");
    assert.notEqual(fingerprintDirs([dir], [])[dir], before);
  } finally {
    cleanup(dir);
  }
});

it("fingerprint ignores listed files and folders", () => {
  const dir = fixture({ "a.txt": "x", "models/big.bin": "y", "skip.log": "z" });
  try {
    const print = fingerprintDirs([dir], ["models", "skip.log"])[dir];
    assert.match(print, /^a\.txt:/);
    assert.equal(print.includes("models"), false);
    assert.equal(print.includes("skip.log"), false);
  } finally {
    cleanup(dir);
  }
});
