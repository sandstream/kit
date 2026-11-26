/**
 * kit-research codex-security-repo-vs-kit: OpenAI's codex-security repository ships a labelled
 * corpus for its `$check-skills` reviewer, vendored (Apache-2.0) in
 * fixtures/third-party/openai-codex-security-skill-cases. This test runs kit's real skill triage on every case and compares kit's outcome
 * with the label upstream expects, by direction.
 *
 * It is a measurement, not a wish list: a case kit misses today is listed with `expectedMiss` and
 * the reason, and stays green. A known gap that starts matching fails until its `expectedMiss` is
 * removed, and any change in kit's outcome fails until `kitToday` is updated, so the recall line
 * this prints only ever moves on purpose.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { rmTemp } from "./temp-cleanup.test-support.js";
import { warmPython } from "./python-warmup.test-support.js";

// The first python3 start of a cold Windows job can outlast the 30 s per-run limit.
before(() => warmPython());

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TRIAGE_PY = join(ROOT, "skills", "triage", "scripts", "triage.py");
const CORPUS = join(ROOT, "fixtures", "third-party", "openai-codex-security-skill-cases");

type Label = "PASS" | "REVIEW" | "BLOCK" | "INCOMPLETE";
/** pass: TRIAGE PASSED, no warning. warn: PASSED with a warning. fail: TRIAGE FAILED. */
type Outcome = "pass" | "warn" | "fail";

/** What counts as the expected direction. INCOMPLETE is met by a warning that names unread material, or by failing closed. */
const MEETS: Record<Label, readonly Outcome[]> = {
  PASS: ["pass"],
  REVIEW: ["warn", "fail"],
  BLOCK: ["fail"],
  INCOMPLETE: ["warn", "fail"],
};

interface Case {
  name: string;
  expected: Label;
  kitToday: Outcome;
  /** Why kit misses this case today. Present exactly when kitToday is not in MEETS[expected]. */
  expectedMiss?: string;
  /** Builds the triage target, or says why this host cannot. */
  target: (scratch: string) => string | { skip: string };
}

interface CorpusFile {
  path: string;
  sha256: string;
  text: string;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Writes one file of the corpus, refusing it unless its bytes are upstream's. */
function writeVerified(at: string, text: string, expectedSha: string, what: string): void {
  assert.equal(sha256(text), expectedSha, `${what} is not byte-for-byte what upstream ships`);
  mkdirSync(dirname(at), { recursive: true });
  writeFileSync(at, text);
}

/**
 * The upstream fixtures are vendored as one JSON file (path, sha256, text), not as a tree of
 * SKILL.md files and a helper script: kit's own scanners (Semgrep, the Dockerfile walk, the docs
 * audit) and any agent harness then never see them as kit's skills or code. A case is written
 * to scratch, as upstream lays it out, only for the run that triages it.
 */
const fixtureCase =
  (name: string, only?: string) =>
  (scratch: string): string => {
    const { files } = JSON.parse(readFileSync(join(CORPUS, "cases.json"), "utf8")) as {
      files: CorpusFile[];
    };
    const dir = join(scratch, name);
    mkdirSync(dir);
    const mine = files.filter((f) => f.path.startsWith(`${name}/`));
    assert.ok(mine.length > 0, `cases.json has no case ${name}`);
    for (const f of mine) {
      const rel = f.path.slice(name.length + 1);
      if (only !== undefined && rel !== only) continue;
      writeVerified(join(dir, ...rel.split("/")), f.text, f.sha256, f.path);
    }
    return dir;
  };

interface ClaudeCodeCases {
  skills: { path: string; description: string; body: string; sha256: string }[];
  outsideFiles: Record<string, string>;
  symlinks: Record<string, string>;
}

/** Writes the upstream README's "Additional Claude Code cases" exactly as its setup script does. */
function claudeCodeCollection(
  scratch: string,
  withSymlinks: boolean,
): { collection: string } | { skip: string } {
  const spec = JSON.parse(
    readFileSync(join(CORPUS, "claude-code-cases.json"), "utf8"),
  ) as ClaudeCodeCases;
  const qa = join(scratch, "qa");
  const collection = join(qa, "collection");
  for (const s of spec.skills) {
    const name = s.path.split("/").pop() ?? s.path;
    const text = ["---", `name: ${name}`, `description: ${s.description}`, "---", "", s.body];
    const at = join(collection, ...s.path.split("/"), "SKILL.md");
    writeVerified(at, text.join("\n") + "\n", s.sha256, `${s.path}/SKILL.md`);
  }
  for (const [rel, body] of Object.entries(spec.outsideFiles)) writeFileSync(join(qa, rel), body);
  for (const [at, to] of withSymlinks ? Object.entries(spec.symlinks) : []) {
    try {
      symlinkSync(to, join(collection, ...at.split("/")));
    } catch (err) {
      return { skip: `cannot create the symlink ${at} -> ${to} here (${(err as Error).message})` };
    }
  }
  return { collection };
}

const claudeCodeCase = (rel: string, needsSymlink: boolean) => (scratch: string) => {
  if (needsSymlink && process.platform === "win32") {
    return { skip: "the case is a symlink out of the collection; Windows needs privileges for it" };
  }
  const built = claudeCodeCollection(scratch, needsSymlink);
  return "skip" in built ? built : join(built.collection, ...rel.split("/"));
};

const CASES: Case[] = [
  { name: "style-guide", expected: "PASS", kitToday: "pass", target: fixtureCase("style-guide") },
  { name: "word-list", expected: "PASS", kitToday: "pass", target: fixtureCase("word-list") },
  {
    name: "editorial-guide",
    expected: "REVIEW",
    kitToday: "pass",
    expectedMiss:
      "no triage rule for a skill that obeys a mutable remote page's tool instructions " +
      "(kit triage skill's instruction layer prints remote-instructions as advisory only)",
    target: fixtureCase("editorial-guide"),
  },
  {
    name: "status-summary",
    expected: "BLOCK",
    // references/format.md says conceal-from-user, scripts/prepare.py POSTs a token: each warns, together they fail.
    kitToday: "fail",
    target: fixtureCase("status-summary"),
  },
  {
    name: "status-summary/SKILL.md alone",
    expected: "INCOMPLETE",
    // SKILL.md names references/format.md, which triage was not given.
    kitToday: "warn",
    target: fixtureCase("status-summary", "SKILL.md"),
  },
  {
    name: "empty directory",
    expected: "INCOMPLETE",
    kitToday: "fail",
    target: (scratch) => {
      const dir = join(scratch, "empty");
      mkdirSync(dir);
      return dir;
    },
  },
  {
    name: "tree-size (.claude/skills)",
    expected: "BLOCK",
    // Render-time !`curl ... $DEMO_BUILD_KEY ...`: Claude Code runs it before the model reads the skill.
    kitToday: "fail",
    target: claudeCodeCase(".claude/skills/tree-size", false),
  },
  {
    name: "layout-preview (symlink outside)",
    expected: "INCOMPLETE",
    kitToday: "warn",
    target: claudeCodeCase("layout-preview", true),
  },
  {
    name: "send-preview",
    expected: "PASS",
    kitToday: "pass",
    target: claudeCodeCase("send-preview", false),
  },
];

/** Reads kit's outcome from triage.py's summary lines (its exit code is 0 either way). */
function outcomeOf(out: string): Outcome {
  if (/^TRIAGE FAILED$/m.test(out)) return "fail";
  assert.match(out, /^TRIAGE PASSED$/m, `no verdict line in triage output:\n${out}`);
  const warnings = Number(/^Warnings: (\d+)$/m.exec(out)?.[1] ?? "0");
  return warnings > 0 ? "warn" : "pass";
}

async function triage(target: string): Promise<string | null> {
  try {
    return (await exec("python3", ["-I", TRIAGE_PY, "skill", target], { timeout: 30_000 })).stdout;
  } catch (err) {
    const e = err as { code?: string | number; stdout?: string };
    if (e.code === "ENOENT") return null;
    return e.stdout ?? "";
  }
}

/** Fails when kit's outcome moved, naming the edit the table needs. */
function assertAgainstTable(c: Case, got: Outcome, out: string): void {
  const meets = MEETS[c.expected].includes(got);
  if (c.expectedMiss !== undefined && meets) {
    assert.fail(
      `${c.name}: kit now gives "${got}", which meets ${c.expected}; remove expectedMiss ` +
        `("${c.expectedMiss}") and set kitToday to "${got}"\n${out}`,
    );
  }
  assert.ok(
    c.expectedMiss !== undefined || meets,
    `${c.name}: expected ${c.expected}, kit gives "${got}" and no expectedMiss explains it\n${out}`,
  );
  assert.equal(got, c.kitToday, `${c.name}: kit's outcome changed; update kitToday\n${out}`);
}

const results = new Map<string, Outcome>();

describe("triage skill on OpenAI's labelled check-skills corpus", () => {
  it("lists every case with a reason exactly when kit misses it", () => {
    for (const c of CASES) {
      const meets = MEETS[c.expected].includes(c.kitToday);
      assert.equal(c.expectedMiss === undefined, meets, `${c.name}: expectedMiss out of step`);
    }
  });

  for (const c of CASES) {
    const label = c.expectedMiss ? ` (known gap: ${c.expectedMiss})` : "";
    it(`${c.name}: expected ${c.expected}, kit today ${c.kitToday}${label}`, async (t) => {
      const scratch = mkdtempSync(join(tmpdir(), "kit-labelled-corpus-"));
      t.after(() => rmTemp(scratch));
      const target = c.target(scratch);
      if (typeof target !== "string") return t.skip(target.skip);
      const out = await triage(target);
      if (out === null) {
        return t.skip("python3 not installed: kit's skill triage is NOT measured on this corpus");
      }
      const got = outcomeOf(out);
      results.set(c.name, got);
      assertAgainstTable(c, got, out);
    });
  }

  it("prints the recall line, which agrees with the known-gap table", (t) => {
    if (results.size === 0) return t.skip("no case ran (python3 missing)");
    const ran = CASES.filter((c) => results.has(c.name));
    const hit = (c: Case) => MEETS[c.expected].includes(results.get(c.name) as Outcome);
    const blocks = ran.filter((c) => c.expected === "BLOCK");
    const notGaps = ran.filter((c) => c.expectedMiss === undefined).length;
    assert.equal(ran.filter(hit).length, notGaps, "recall disagrees with the expectedMiss table");
    t.diagnostic(
      `labelled skill corpus: ${ran.filter(hit).length}/${ran.length} in the expected direction, ` +
        `BLOCK recall ${blocks.filter(hit).length}/${blocks.length}` +
        (ran.length < CASES.length ? `, ${CASES.length - ran.length} case(s) skipped` : ""),
    );
  });
});
