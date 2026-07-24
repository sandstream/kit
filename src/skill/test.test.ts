import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSkillManifest,
  skillInvocationPosture,
  checkContract,
  checkTrigger,
  checkScope,
  checkRegression,
  triggerKey,
  skillFingerprint,
  snapshotOf,
  testSkill,
  DISCLAIMED,
  type SkillManifest,
} from "./test.js";

const GOOD = `---
name: run-tests
description: Run the project's test suite before committing changes. Use when the user asks to test or verify.
allowed-tools: Read, Bash, Grep
---

# run-tests

## Intent
Run tests.

## Steps
1. Run the suite.
`;

describe("parseSkillManifest", () => {
  it("parses name, description, and inline allowed-tools", () => {
    const m = parseSkillManifest(GOOD);
    assert.equal(m.hasFrontmatter, true);
    assert.equal(m.name, "run-tests");
    assert.match(m.description!, /^Run the project's test suite/);
    assert.deepEqual(m.allowedTools, ["Read", "Bash", "Grep"]);
    assert.ok(m.body.includes("## Intent"));
  });

  it("parses a YAML block-list allowed-tools", () => {
    const m = parseSkillManifest(`---
name: x
description: does a thing when asked
allowed-tools:
  - Read
  - Grep
---
body`);
    assert.deepEqual(m.allowedTools, ["Read", "Grep"]);
  });

  it("parses a bracketed inline list and strips quotes", () => {
    const m = parseSkillManifest(`---
name: x
description: "quoted desc that is long enough"
allowed-tools: ["Read", 'Bash']
---
body`);
    assert.deepEqual(m.allowedTools, ["Read", "Bash"]);
    assert.equal(m.description, "quoted desc that is long enough");
  });

  it("reports no frontmatter for a plain file (never throws)", () => {
    const m = parseSkillManifest("# just markdown\n\nno frontmatter here");
    assert.equal(m.hasFrontmatter, false);
    assert.equal(m.name, undefined);
    assert.equal(m.allowedTools, undefined);
    assert.ok(m.body.length > 0);
  });

  it("distinguishes absent allowed-tools from an empty one", () => {
    const absent = parseSkillManifest(`---
name: x
description: a description long enough to pass
---
body`);
    assert.equal(absent.allowedTools, undefined);
  });
});

describe("checkContract", () => {
  it("passes a well-formed manifest", () => {
    assert.equal(checkContract(parseSkillManifest(GOOD)).status, "pass");
  });
  it("fails without frontmatter", () => {
    assert.equal(checkContract(parseSkillManifest("# no fm")).status, "fail");
  });
  it("fails a non-slug name", () => {
    const m = parseSkillManifest(`---
name: Not A Slug
description: a description that is long enough
---
body`);
    assert.equal(checkContract(m).status, "fail");
  });
  it("fails a too-short description", () => {
    const m = parseSkillManifest(`---
name: x
description: short
---
body`);
    const r = checkContract(m);
    assert.equal(r.status, "fail");
    assert.match(r.detail, /description/);
  });
  it("fails an empty body", () => {
    const m = parseSkillManifest(`---
name: x
description: a description that is definitely long enough
---
`);
    assert.equal(checkContract(m).status, "fail");
  });
});

describe("triggerKey + checkTrigger", () => {
  it("normalizes descriptions to a stable key", () => {
    const a = parseSkillManifest(`---
name: a
description: "Run the Tests!"
---
b`);
    const b = parseSkillManifest(`---
name: b
description: run   the tests
---
b`);
    assert.equal(triggerKey(a), triggerKey(b));
  });

  it("passes when a trigger is declared and no siblings", () => {
    assert.equal(checkTrigger(parseSkillManifest(GOOD)).status, "pass");
  });

  it("fails with no description", () => {
    const m = parseSkillManifest(`---
name: x
---
body`);
    assert.equal(checkTrigger(m).status, "fail");
  });

  it("fails on a sibling trigger collision, ignores itself", () => {
    const m = parseSkillManifest(GOOD);
    const key = triggerKey(m);
    const collide = checkTrigger(m, [
      { name: "run-tests", triggerKey: key }, // itself — must be ignored
      { name: "other", triggerKey: key },
    ]);
    assert.equal(collide.status, "fail");
    assert.match(collide.detail, /other/);

    const ok = checkTrigger(m, [{ name: "unrelated", triggerKey: "something else" }]);
    assert.equal(ok.status, "pass");
  });
});

describe("checkScope (declared least-privilege)", () => {
  const withTools = (tools?: string): SkillManifest =>
    parseSkillManifest(`---
name: x
description: a description long enough to be valid
${tools === undefined ? "" : `allowed-tools: ${tools}`}
---
body`);

  it("fails when allowed-tools is absent", () => {
    const r = checkScope(withTools(undefined));
    assert.equal(r.status, "fail");
    assert.match(r.detail, /ALL tools/);
  });
  it("fails on a wildcard", () => {
    assert.equal(checkScope(withTools("*")).status, "fail");
    assert.equal(checkScope(withTools("all")).status, "fail");
  });
  it("passes a bounded list", () => {
    const r = checkScope(withTools("Read, Grep"));
    assert.equal(r.status, "pass");
    assert.match(r.detail, /2 tool/);
  });
});

describe("skillFingerprint + checkRegression", () => {
  it("fingerprint is stable and ignores scope order", () => {
    const a = parseSkillManifest(`---
name: x
description: a stable description here
allowed-tools: Read, Bash
---
body`);
    const b = parseSkillManifest(`---
name: x
description: a stable description here
allowed-tools: Bash, Read
---
different body text does not matter`);
    assert.equal(skillFingerprint(a), skillFingerprint(b));
  });

  it("fingerprint moves when the declared scope changes", () => {
    const a = parseSkillManifest(GOOD);
    const b = parseSkillManifest(GOOD.replace("Read, Bash, Grep", "Read"));
    assert.notEqual(skillFingerprint(a), skillFingerprint(b));
  });

  it("skips with no snapshot, passes on match, fails on drift", () => {
    const m = parseSkillManifest(GOOD);
    assert.equal(checkRegression(m, null).status, "skip");
    assert.equal(checkRegression(m, snapshotOf(m)).status, "pass");
    const stale = { ...snapshotOf(m), fingerprint: "sha256:deadbeefdeadbeef" };
    assert.equal(checkRegression(m, stale).status, "fail");
  });
});

describe("testSkill — the folded report", () => {
  it("ok when no check fails; always carries the three disclaimers", () => {
    const r = testSkill(parseSkillManifest(GOOD), {
      snapshot: snapshotOf(parseSkillManifest(GOOD)),
    });
    assert.equal(r.ok, true);
    assert.equal(r.hasSkips, false);
    assert.equal(r.checks.length, 4);
    assert.equal(r.disclaimed.length, 3);
    assert.deepEqual([...r.disclaimed].map((d) => d.id).sort(), [
      "negative-controls",
      "rubric",
      "scope-adherence",
    ]);
  });

  it("not ok when a check fails", () => {
    const r = testSkill(parseSkillManifest("# no frontmatter"));
    assert.equal(r.ok, false);
  });

  it("ok-but-hasSkips when only regression is skipped", () => {
    const r = testSkill(parseSkillManifest(GOOD)); // no snapshot
    assert.equal(r.ok, true);
    assert.equal(r.hasSkips, true);
  });

  it("rubric is permanently disclaimed (zero-LLM boundary)", () => {
    assert.ok(DISCLAIMED.some((d) => d.id === "rubric" && /never run by kit/.test(d.reason)));
  });
});

describe("agentskills.io invocation-control fields", () => {
  it("parses user-invokable + disable-model-invocation booleans (dash and underscore)", () => {
    const m = parseSkillManifest(
      "---\nname: x\ndescription: does a thing well enough\nuser-invokable: false\ndisable-model-invocation: true\n---\nbody",
    );
    assert.equal(m.userInvokable, false);
    assert.equal(m.disableModelInvocation, true);
    const m2 = parseSkillManifest(
      "---\nname: x\ndescription: does a thing well enough\nuser_invokable: true\ndisable_model_invocation: false\n---\nbody",
    );
    assert.equal(m2.userInvokable, true);
    assert.equal(m2.disableModelInvocation, false);
  });

  it("posture is null when neither field is present (no change to legacy skills)", () => {
    const m = parseSkillManifest("---\nname: x\ndescription: does a thing well enough\n---\nbody");
    assert.equal(skillInvocationPosture(m), null);
    assert.equal(m.userInvokable, undefined);
    assert.equal(m.disableModelInvocation, undefined);
  });

  it("posture reports model-invocation disabled + not user-invokable", () => {
    const m = parseSkillManifest(
      "---\nname: x\ndescription: does a thing well enough\ndisable-model-invocation: true\nuser-invokable: false\n---\nbody",
    );
    assert.equal(skillInvocationPosture(m), "model-invocation disabled, not user-invokable");
  });
});
