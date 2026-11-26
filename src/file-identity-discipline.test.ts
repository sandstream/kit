/**
 * CLAUDE.md: "File ids (`ino`) need `bigint` stats (`src/utils/same-file.ts`)". On Windows a
 * number `ino` is a 64- or 128-bit file id squeezed into a double, so two different files can
 * compare equal and an identity check passes for the wrong file.
 *
 * The rule lived in prose only. When it was measured (the third `kit rig` run, kit-research
 * `rig-v3-kit-agent-rules.md`), a reviewer holding the rule caught this class in 2–3 of 3 runs and
 * a reviewer without it never did. Six comparisons in src/ broke the rule that day. A rule that a
 * line scan can enforce is a test, not a sentence: every dev/ino comparison goes through
 * `sameIdentity`, which takes bigint stats only.
 *
 * Tests are scanned too. A helper in src/memory/project.test.ts compared `statSync().ino` as a
 * number, and on Windows CI two sibling directories compared equal (kit#1057). A test may compare
 * `ino` directly only when every operand was bound in that file from a `{ bigint: true }` stat.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(process.cwd(), "src");
const HOME = join("src", "utils", "same-file.ts");
/** This file: its fixtures are comparisons on purpose. */
const SELF = join("src", "file-identity-discipline.test.ts");

/** A stat call with `{ bigint: true }` bound to a name: `const x = statSync(p, { bigint: true })`. */
const BIGINT_BINDING =
  /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?[\w.]*stat(?:Sync)?\([^;]*\{[^}]*\bbigint:\s*true\b/;

/** Names a file binds to bigint stats; a test may compare their `ino` fields directly. */
function bigintNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = BIGINT_BINDING.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

/**
 * A line that compares an `ino` field with `===`/`!==`, other than against the bigint zero or
 * between fields of names in `bigint` (stats read with `{ bigint: true }`).
 */
function comparesIno(line: string, bigint: ReadonlySet<string> = new Set()): boolean {
  if (!/\.ino\s*[!=]==|[!=]==\s*[\w.?!]+\.ino\b/.test(line)) return false;
  if (/\.ino\s*[!=]==\s*0n\b/.test(line)) return false;
  const receivers = [...line.matchAll(/([\w.?!]+)\.ino\b/g)].map((m) => m[1]);
  return !receivers.every((name) => bigint.has(name));
}

/** The files the scan reads: src/**\/*.ts, tests included, declarations excluded. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (/\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

const TEST = /\.(test|test-support)\.ts$/;

/** `file:line` for each offending comparison in `text`; only tests get the bigint exception. */
function offendersIn(rel: string, text: string): string[] {
  const bigint = TEST.test(rel) ? bigintNames(text) : new Set<string>();
  const out: string[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (comparesIno(line, bigint)) out.push(`${rel.split(sep).join("/")}:${i + 1}`);
  });
  return out;
}

describe("comparesIno", () => {
  it("flags a direct ino comparison in either operand order", () => {
    assert.equal(comparesIno("if (a.ino !== b.ino) return;"), true);
    assert.equal(comparesIno("    before.ino === after.ino &&"), true);
    assert.equal(comparesIno("ok = x === entry.ino"), true);
  });

  it("allows the zero check, sameIdentity and lines that only read ino", () => {
    assert.equal(comparesIno("if (info.ino === 0n) return;"), false);
    assert.equal(comparesIno("if (!sameIdentity(a, b)) throw err;"), false);
    assert.equal(comparesIno("const id = String(info.ino);"), false);
  });
});

describe("comparesIno with bigint stats", () => {
  const bigint = new Set(["original", "copy"]);

  it("allows a comparison whose every operand is a bigint stat", () => {
    assert.equal(
      comparesIno("ok(original.dev !== copy.dev || original.ino !== copy.ino);", bigint),
      false,
    );
  });

  it("still flags a number stat, or one bigint operand against a number one", () => {
    assert.equal(
      comparesIno("return a.ino !== 0 && a.dev === b.dev && a.ino === b.ino;", bigint),
      true,
    );
    assert.equal(comparesIno("ok(original.ino === other.ino);", bigint), true);
  });
});

describe("bigintNames and offendersIn", () => {
  it("binds names only from stat calls that pass { bigint: true }", () => {
    const text = [
      "const a = statSync(p, { bigint: true });",
      "const b = await lstat(q, { bigint: true, throwIfNoEntry: false });",
      "const c = statSync(r);",
    ].join("\n");
    assert.deepEqual([...bigintNames(text)], ["a", "b"]);
  });

  it("flags a number-ino helper in a test, the kit#1057 shape", () => {
    const helper = [
      "const a = statSync(candidate);",
      "const b = statSync(path);",
      "return a.ino !== 0 && a.dev === b.dev && a.ino === b.ino;",
    ].join("\n");
    assert.deepEqual(offendersIn(join("src", "x.test.ts"), helper), ["src/x.test.ts:3"]);
  });

  it("gives source files no bigint exception: they must call sameIdentity", () => {
    const text = "const a = statSync(p, { bigint: true });\nif (a.ino === a.ino) x();";
    assert.deepEqual(offendersIn(join("src", "x.ts"), text), ["src/x.ts:2"]);
    assert.deepEqual(offendersIn(join("src", "x.test.ts"), text), []);
  });
});

describe("file identity discipline", () => {
  it("compares dev/ino only in src/utils/same-file.ts or over bigint stats in tests", () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const rel = relative(process.cwd(), file);
      if (rel === HOME || rel === SELF) continue;
      offenders.push(...offendersIn(rel, readFileSync(file, "utf8")));
    }
    assert.deepEqual(
      offenders,
      [],
      "compare file identity with sameIdentity() over bigint stats (src/utils/same-file.ts)",
    );
  });
});
