import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, relative } from "node:path";

/**
 * kit's own surface is English. Commands, flags, labels, skill trigger phrases and printed
 * output are English, in every file this repo ships.
 *
 * WHY THIS IS A TEST AND NOT A CONVENTION. kit shipped a Swedish human-in-the-loop block for
 * months — `HITL behövs` / `Ägare:` / `Gör detta:` / `Svara med:` — printed by `kit check`, pinned
 * by two test files, and reproduced in README. A Swedish trigger phrase ("kör apa-test") sat in
 * `skills/monkey-test/SKILL.md`, so the documented way to invoke a kit skill was a Swedish
 * sentence. None of it was caught by review, because nothing looked for it.
 *
 * It also is not a spelling check. A grep for `åäö` finds five of the six labels above and misses
 * `Svara med:` entirely — that one has no diacritic. So this scans for Swedish FUNCTION WORDS as
 * whole words as well, which is what makes a sentence Swedish regardless of its letters.
 *
 * WHAT IS DELIBERATELY ALLOWED. Three things are not violations and each is named individually
 * below with a reason, never waved through by pattern:
 *
 *   1. A person's name. `Sandström` is spelled the way its owner spells it.
 *   2. Swedish in INPUT-matching patterns. kit detecting `nej` / `istället` / `måste` in what a
 *      USER wrote is kit understanding Swedish, which is the opposite of kit speaking it. Deleting
 *      those would remove a capability from exactly the users this repo has.
 *   3. Non-ASCII TEST FIXTURES. `ÅÖÄ` exists to prove case folding works on it.
 *
 * `CHANGELOG.md` is out of scope: it records what shipped, including the Swedish that shipped, and
 * rewriting history to satisfy a linter would be a lie about the past.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SCAN_DIRS = ["src", "skills", "docs", ".github", "scripts"];
const SCAN_FILES = ["README.md", "package.json", "eslint.config.js", "docker-compose.yml"];
/**
 * `package-lock.json` is excluded: it is generated, and third-party package metadata is not kit's
 * surface. `CHANGELOG.md` is excluded for the reason given above.
 */
const SCAN_EXCLUDE = new Set(["package-lock.json", "CHANGELOG.md"]);
const SCAN_EXT = [".ts", ".js", ".md", ".json", ".toml", ".yml", ".yaml"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage"]);

/**
 * Swedish function words that do not occur as English words. Deliberately excludes near-homographs
 * ("med", "man", "i", "en", "har") — a list that flags English prose gets switched off, and a gate
 * nobody trusts is worse than no gate.
 */
const SWEDISH_WORDS = [
  "agenten",
  "aldrig",
  "alltid",
  "behövs",
  "dessa",
  "detta",
  "fortsätter",
  "fråga",
  "förbjud",
  "gör",
  "istället",
  "klart",
  "kör",
  "körs",
  "måste",
  "något",
  "någon",
  "nej",
  "och",
  "saknas",
  "ska",
  "skall",
  "sluta",
  "svara",
  "varför",
  "ägare",
];
const SWEDISH_RE = new RegExp(`(?<![\\p{L}])(${SWEDISH_WORDS.join("|")})(?![\\p{L}])`, "giu");
const DIACRITIC_RE = /[åäöÅÄÖ]/gu;

/** Each entry is an exact substring, a file it may appear in, and why it is not a violation. */
const ALLOWED: { file: string; snippet: string; why: string }[] = [
  {
    file: "*",
    snippet: "Sandström",
    why: "a person's name, spelled the way its owner spells it",
  },
  {
    file: "src/agent-config.ts",
    snippet: "\\b(ska|måste|alltid|aldrig|förbjud)\\b",
    why: "detects normative language in what a USER wrote — kit reading Swedish, not speaking it",
  },
  {
    file: "src/memory/learn.ts",
    snippet: "nej|sluta|fel|inte|istället|igen",
    why: "correction detection over USER input, alongside the English alternatives",
  },
  {
    file: "src/memory/learn.ts",
    snippet: '"no", "stop", "instead", "nej", "istället"',
    why: "comment naming the input tokens matched by the pattern above",
  },
  {
    file: "src/memory/learn.ts",
    snippet: '"ok", "kör", "yes"',
    why: "comment naming short user replies the boilerplate filter drops",
  },
  {
    file: "src/memory/learn.test.ts",
    snippet: "ÅÖÄ",
    why: "fixture proving case folding handles non-ASCII letters",
  },
  {
    file: "src/memory/learn.test.ts",
    snippet: "åöä",
    why: "the folded form the fixture above asserts on",
  },
  {
    file: "src/skill/test.trigger.test.ts",
    snippet: "NON_LATIN",
    why: "non-Latin fixtures proving triggerKey no longer deletes them (none are Swedish)",
  },
];

/**
 * This file is the one exemption, and it cannot be otherwise: a list of forbidden Swedish words
 * contains Swedish words, so scanning it would fail on its own definition. Exactly one path is
 * exempt and the test below asserts that, so the exemption cannot quietly widen into a hiding
 * place.
 */
const SELF = "src/english-only.test.ts";

function scanTargets(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (SCAN_EXT.some((e) => entry.name.endsWith(e)) && !SCAN_EXCLUDE.has(entry.name)) {
        out.push(join(dir, entry.name));
      }
    }
  };
  for (const d of SCAN_DIRS) walk(join(REPO_ROOT, d));
  for (const f of SCAN_FILES) out.push(join(REPO_ROOT, f));
  return out.filter((f) => relative(REPO_ROOT, f).split("\\").join("/") !== SELF);
}

/** Strip the allowances that apply to this file, so what remains is unexplained Swedish. */
function redactAllowed(rel: string, text: string): string {
  let out = text;
  for (const a of ALLOWED) {
    if (a.file !== "*" && a.file !== rel) continue;
    out = out.split(a.snippet).join(" ");
  }
  // The allow-list entry for the non-Latin fixtures covers the whole block it names.
  if (rel === "src/skill/test.trigger.test.ts") out = out.replace(/[^\p{ASCII}]/gu, " ");
  return out;
}

describe("kit's own surface is English", () => {
  const targets = scanTargets();

  it("scans a non-trivial number of files (the gate is not vacuously green)", () => {
    // An empty scan would pass every assertion below. The oracle problem, pre-empted.
    assert.ok(targets.length > 200, `only ${targets.length} files scanned — walk is broken`);
  });

  it("has no Swedish letters outside the named allowances", () => {
    const offenders: string[] = [];
    for (const file of targets) {
      const rel = relative(REPO_ROOT, file).split("\\").join("/");
      const text = redactAllowed(rel, readFileSync(file, "utf8"));
      text.split("\n").forEach((line, i) => {
        if (DIACRITIC_RE.test(line))
          offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
        DIACRITIC_RE.lastIndex = 0;
      });
    }
    assert.deepEqual(offenders, [], `Swedish letters found:\n${offenders.join("\n")}`);
  });

  it("has no Swedish function words outside the named allowances", () => {
    // This is the half that catches `Svara med:` — Swedish with no diacritic to grep for.
    const offenders: string[] = [];
    for (const file of targets) {
      const rel = relative(REPO_ROOT, file).split("\\").join("/");
      const text = redactAllowed(rel, readFileSync(file, "utf8"));
      text.split("\n").forEach((line, i) => {
        const found = line.match(SWEDISH_RE);
        SWEDISH_RE.lastIndex = 0;
        if (found)
          offenders.push(`${rel}:${i + 1}: [${found.join(", ")}] ${line.trim().slice(0, 80)}`);
      });
    }
    assert.deepEqual(offenders, [], `Swedish words found:\n${offenders.join("\n")}`);
  });

  it("exempts exactly one file, itself", () => {
    const all = scanTargets().map((f) => relative(REPO_ROOT, f).split("\\").join("/"));
    assert.ok(!all.includes(SELF), "the scan must skip this file");
    assert.ok(
      readFileSync(join(REPO_ROOT, SELF), "utf8").includes("SWEDISH_WORDS"),
      "the exempt file must be the word list itself, not some other file",
    );
  });

  it("keeps every allowance justified", () => {
    // An allowance with no reason is a silent exemption, which is the failure this file exists
    // to prevent. Also fails when an allowance stops matching, so the list cannot rot.
    for (const a of ALLOWED) {
      assert.ok(a.why.length > 20, `allowance for "${a.snippet}" has no real reason`);
      if (a.file === "*") continue;
      const text = readFileSync(join(REPO_ROOT, a.file), "utf8");
      assert.ok(
        text.includes(a.snippet),
        `stale allowance: ${a.file} no longer contains "${a.snippet}" — delete the entry`,
      );
    }
  });

  it("pins the labels that regressed, so they cannot come back", () => {
    const hitl = readFileSync(join(REPO_ROOT, "src/hitl.ts"), "utf8");
    for (const gone of ["HITL behövs", "Ägare:", "Gör detta:", "Svara med:", "Varför agenten"])
      assert.ok(!hitl.includes(gone), `Swedish HITL label is back: ${gone}`);
    for (const present of ["HITL required", "Owner:", "Do this:", "Respond with:"])
      assert.ok(hitl.includes(present), `English HITL label missing: ${present}`);

    const skill = readFileSync(join(REPO_ROOT, "skills/monkey-test/SKILL.md"), "utf8");
    assert.ok(!skill.includes("apa-test"), "Swedish trigger phrase is back in monkey-test");
  });
});
