// Trigger-normalization tests, kept beside `test.test.ts` rather than inside it: lizard parses
// that file as one anonymous block already over the 80-line limit and baselined at 225/241, so
// any line added there is a fresh ratchet finding. See test.scope.test.ts for the same note.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSkillManifest, triggerKey, checkTrigger, checkContract } from "./test.js";

const withDescription = (description: string) =>
  parseSkillManifest(`---
name: x
description: ${description}
allowed-tools: Read
---
body`);

describe("triggerKey — non-Latin descriptions", () => {
  // An ASCII-only character class deleted every non-Latin letter, so these normalized to "" and
  // checkTrigger failed them for having "no description" — in the same run where checkContract
  // passed them for HAVING one. Restore `[^a-z0-9]` and the first three go red.
  // All at least MIN_DESCRIPTION (12) characters: that bar is counted in CHARACTERS, so it is
  // tuned for English and a short-but-complete CJK description can fall under it. Out of scope
  // here — this file is about the normalizer, and a too-short description fails correctly.
  const NON_LATIN: Record<string, string> = {
    Chinese: "审查代码并在发现严重问题时阻止提交",
    Japanese: "コミット前にコードをレビューして重大な問題を報告する",
    Cyrillic: "Проверить код перед коммитом",
    Greek: "Έλεγχος κώδικα πριν από την υποβολή",
    Arabic: "مراجعة الكود قبل الالتزام",
  };

  it("keeps a non-Latin description from normalizing away", () => {
    for (const [script, description] of Object.entries(NON_LATIN))
      assert.notEqual(triggerKey(withDescription(description)), "", `${script} normalized to ""`);
  });

  it("does not contradict checkContract on the same manifest", () => {
    for (const [script, description] of Object.entries(NON_LATIN)) {
      const m = withDescription(description);
      assert.equal(checkContract(m).status, "pass", `${script}: contract`);
      assert.equal(
        checkTrigger(m).status,
        "pass",
        `${script}: contract says the description is declared, so trigger must not say it is absent`,
      );
    }
  });

  it("keeps two different non-Latin descriptions distinct", () => {
    // Under the old rule both were "", i.e. equal — a latent false collision behind the
    // empty-key guard that fires first.
    const keys = Object.values(NON_LATIN).map((d) => triggerKey(withDescription(d)));
    assert.equal(new Set(keys).size, keys.length, "distinct descriptions produced equal keys");
  });

  it("leaves a pure-ASCII key byte-identical", () => {
    assert.equal(
      triggerKey(withDescription("Review code and block on blockers")),
      "review code and block on blockers",
    );
  });

  it("still folds case and collapses punctuation runs", () => {
    assert.equal(triggerKey(withDescription("Run  TESTS -- now, please.")), "run tests now please");
  });

  it("still reports a genuinely absent description", () => {
    const m = parseSkillManifest(`---\nname: x\nallowed-tools: Read\n---\nbody`);
    assert.equal(triggerKey(m), "");
    assert.equal(checkTrigger(m).status, "fail");
  });
});
