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
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(process.cwd(), "src");
const HOME = join("src", "utils", "same-file.ts");

/** A line that compares an `ino` field with `===`/`!==`, other than against the bigint zero. */
function comparesIno(line: string): boolean {
  if (!/\.ino\s*[!=]==|[!=]==\s*[\w.?!]+\.ino\b/.test(line)) return false;
  return !/\.ino\s*[!=]==\s*0n\b/.test(line);
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (/\.ts$/.test(entry.name) && !/\.(test|test-support)\.ts$|\.d\.ts$/.test(entry.name))
      out.push(full);
  }
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

describe("file identity discipline", () => {
  it("compares dev/ino only in src/utils/same-file.ts", () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const rel = relative(process.cwd(), file);
      if (rel === HOME) continue;
      readFileSync(file, "utf8")
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (comparesIno(line)) offenders.push(`${rel.split(sep).join("/")}:${i + 1}`);
        });
    }
    assert.deepEqual(
      offenders,
      [],
      "compare file identity with sameIdentity() over bigint stats (src/utils/same-file.ts)",
    );
  });
});
