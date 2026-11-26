/**
 * `contract` enforces the Agent Skills specification limits (https://agentskills.io/specification).
 * Claude Code, OpenAI Codex and the other harnesses that load a `SKILL.md` read the same
 * frontmatter, so a skill outside these limits is one a conforming harness may refuse to load.
 *
 * Before this, an 80-character name with a 2,880-character description in a folder named `x`
 * passed `contract`.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkContract, parseSkillManifest, testSkill } from "./test.js";
import { skillDirName } from "../commands/skill.js";
import { rmTemp } from "../temp-cleanup.test-support.js";

const skill = (name: string, description: string, extra = "") =>
  parseSkillManifest(
    `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\nDo the thing.\n`,
  );
const DESC = "Run the project's test suite before committing changes.";

describe("contract: agentskills.io limits (measured gap)", () => {
  it("fails an 80-character name with a 2,880-character description in folder x", () => {
    const m = skill("a".repeat(80), "d".repeat(2880));
    const r = checkContract(m, { dirName: "x" });
    assert.equal(r.status, "fail");
    assert.match(r.detail, /name is 80 characters/);
    assert.match(r.detail, /description is 2880 characters/);
    assert.match(r.detail, /folder "x"/);
    assert.match(r.detail, /agentskills\.io\/specification/);
  });
  it("testSkill threads the folder name to contract", () => {
    const r = testSkill(skill("run-tests", DESC), { dirName: "x" });
    assert.equal(r.checks.find((c) => c.id === "contract")?.status, "fail");
  });
});

describe("contract: name rules", () => {
  const fails = (name: string, dir: string, rx: RegExp) => {
    const r = checkContract(skill(name, DESC), { dirName: dir });
    assert.equal(r.status, "fail", name);
    assert.match(r.detail, rx);
  };
  it("passes at exactly 64 characters in a matching folder", () => {
    const n = "a".repeat(64);
    assert.equal(checkContract(skill(n, DESC), { dirName: n }).status, "pass");
  });
  it("fails 65 characters and names the length", () =>
    fails("a".repeat(65), "a".repeat(65), /name is 65 characters; the spec allows 1-64/));
  it("names the offending character", () =>
    fails("run_tests", "run_tests", /name "run_tests" contains "_" \(U\+005F\)/));
  it("rejects uppercase", () => fails("Run-tests", "Run-tests", /contains "R"/));
  it("rejects a leading hyphen", () => fails("-run", "-run", /starts or ends with a hyphen/));
  it("rejects a trailing hyphen", () => fails("run-", "run-", /starts or ends with a hyphen/));
  it("rejects consecutive hyphens", () => fails("run--tests", "run--tests", /consecutive hyphens/));
  it("rejects a folder that does not match", () =>
    fails("run-tests", "tests", /name "run-tests" does not match its folder "tests"/));
  it("accepts unicode lowercase letters, as the spec and its skills-ref validator do", () => {
    assert.equal(
      checkContract(skill("café-notes", DESC), { dirName: "café-notes" }).status,
      "pass",
    );
  });
  it("compares the folder after NFKC normalization, as skills-ref does", () => {
    const nfd = "café-notes";
    assert.equal(checkContract(skill("café-notes", DESC), { dirName: nfd }).status, "pass");
  });
  it("skips the folder rule when no folder is known", () => {
    assert.equal(checkContract(skill("run-tests", DESC)).status, "pass");
  });
});

describe("contract: description and compatibility limits", () => {
  it("passes a 1024-character description and fails 1025", () => {
    assert.equal(checkContract(skill("x", "d".repeat(1024)), { dirName: "x" }).status, "pass");
    const r = checkContract(skill("x", "d".repeat(1025)), { dirName: "x" });
    assert.equal(r.status, "fail");
    assert.match(r.detail, /description is 1025 characters; the spec allows 1-1024/);
  });
  it("counts a folded block-scalar description", () => {
    const m = parseSkillManifest(
      `---\nname: x\ndescription: >\n  ${"w".repeat(600)}\n  ${"w".repeat(600)}\n---\nbody\n`,
    );
    assert.match(checkContract(m).detail, /description is 1201 characters/);
  });
  it("fails a compatibility over 500 characters, and an empty one", () => {
    const long = checkContract(skill("x", DESC, `compatibility: ${"c".repeat(501)}\n`));
    assert.equal(long.status, "fail");
    assert.match(long.detail, /compatibility is 501 characters; the spec allows 1-500/);
    const empty = checkContract(skill("x", DESC, "compatibility:\n"));
    assert.match(empty.detail, /compatibility is 0 characters/);
    assert.equal(checkContract(skill("x", DESC, "compatibility: Requires git\n")).status, "pass");
  });
});

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("contract over every SKILL.md kit ships and the vendored corpus", () => {
  it("passes each of kit's own skills in its folder", () => {
    const dirs = readdirSync(join(ROOT, "skills"), { withFileTypes: true }).filter((d) =>
      d.isDirectory(),
    );
    assert.ok(dirs.length >= 3);
    for (const d of dirs) {
      const m = parseSkillManifest(readFileSync(join(ROOT, "skills", d.name, "SKILL.md"), "utf8"));
      const r = checkContract(m, { dirName: d.name });
      assert.equal(r.status, "pass", `skills/${d.name}: ${r.detail}`);
    }
  });
  it("passes each SKILL.md in the codex-security corpus", () => {
    const corpus = join(ROOT, "fixtures", "third-party", "openai-codex-security-skill-cases");
    const { files } = JSON.parse(readFileSync(join(corpus, "cases.json"), "utf8")) as {
      files: { path: string; text: string }[];
    };
    const { skills } = JSON.parse(readFileSync(join(corpus, "claude-code-cases.json"), "utf8")) as {
      skills: { path: string; description: string; body: string }[];
    };
    const cases = [
      ...files
        .filter((f) => f.path.endsWith("/SKILL.md"))
        .map((f) => ({ path: f.path, text: f.text })),
      // claude-code-cases.json writes `name: <last path segment>` (its _layout says so).
      ...skills.map((s) => {
        const name = s.path.split("/").pop()!;
        return {
          path: `${s.path}/SKILL.md`,
          text: `---\nname: ${name}\ndescription: ${s.description}\n---\n\n${s.body}\n`,
        };
      }),
    ];
    assert.equal(cases.length, 7);
    for (const c of cases) {
      const segs = c.path.split("/");
      const r = checkContract(parseSkillManifest(c.text), { dirName: segs[segs.length - 2] });
      assert.equal(r.status, "pass", `${c.path}: ${r.detail}`);
    }
  });
});

describe("kit skill test reads the folder name from disk", () => {
  const root = mkdtempSync(join(tmpdir(), "kit-skill-dir-"));
  after(() => rmTemp(root));
  mkdirSync(join(root, "My-Skill"));
  writeFileSync(join(root, "My-Skill", "SKILL.md"), "---\nname: my-skill\n---\n");
  it("returns the folder of a SKILL.md", () => {
    assert.equal(skillDirName(join(root, "My-Skill", "SKILL.md")), "My-Skill");
  });
  it("returns the on-disk case when the path was typed in another case", () => {
    assert.equal(skillDirName(join(root, "my-skill", "SKILL.md")), "My-Skill");
  });
  it("returns undefined for a file that is not a SKILL.md", () => {
    assert.equal(skillDirName(join(root, "My-Skill", "notes.md")), undefined);
  });
});
