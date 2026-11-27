import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyToken, constraintRefs, ruleChanges } from "./instruction-constraints.js";

describe("instruction constraints: tokens", () => {
  it("keeps paths, identifiers and env vars, and drops commands, URLs and placeholders", () => {
    const cases: [string, string | null][] = [
      ["src/utils/same-file.ts", "path src/utils/same-file.ts"],
      ["src/skill-rule-gates.ts:21-29", "path src/skill-rule-gates.ts"],
      ["src/utils/**", "path src/utils"],
      [".kit.toml", "path .kit.toml"],
      ["package.json", "path package.json"],
      ["legacyHandler()", "identifier legacyHandler"],
      ["Guid.NewGuid()", "identifier NewGuid"],
      ["enforced_by", "identifier enforced_by"],
      ["KIT_NON_INTERACTIVE", "env KIT_NON_INTERACTIVE"],
      ["$GITHUB_TOKEN", "env GITHUB_TOKEN"],
      ["kit check --category security", null],
      ["https://example.com/a.md", null],
      ["--allow", null],
      ["node:path", null],
      ["~/.claude/settings.json", null],
      ["/tmp", null],
      ["@types/node", null],
      ["kit triage repo <target>", null],
      [".env*", null],
      ["bigint", null],
      ["kit-enforce", null],
      ["v1.2.3", null],
    ];
    for (const [raw, want] of cases) {
      const t = classifyToken(raw);
      assert.equal(t ? `${t.kind} ${t.probe}` : null, want, raw);
    }
  });

  it("reads rule lines only, outside code fences, and marks prohibitions", () => {
    const text = [
      "Never call `legacyHandler()`; partners depend on it.",
      "Always run `scripts/sync.sh` first.",
      "The `src/notes.ts` file is plain prose.",
      "```",
      "never `src/in-fence.ts`",
      "```",
    ].join("\n");
    assert.deepEqual(
      constraintRefs("CLAUDE.md", text).map((r) => `${r.line} ${r.probe} ${r.prohibitive}`),
      ["1 legacyHandler true", "2 scripts/sync.sh false"],
    );
  });
});

describe("instruction constraints: against HEAD", () => {
  const HEAD = [
    "# Rules",
    "- Never build paths with `/`; use `node:path`.",
    "- Never put a session URL in a PR body.",
    "- Always run `kit check` before you push.",
    "- Do not edit `dist/` by hand.",
    "- Only the owner merges protected paths.",
    "Plain prose that says nothing strong.",
  ].join("\n");

  it("lists a removed rule line and a 'never' softened to 'avoid' or 'prefer not'", () => {
    const now = [
      "# Rules",
      "- Avoid building paths with `/`; use `node:path`.",
      "- Prefer not to put a session URL in a PR body.",
      "- Only the owner merges protected paths.",
      "- Do not edit `dist/` by hand.",
    ].join("\n");
    assert.deepEqual(
      ruleChanges("CLAUDE.md", HEAD, now).map((c) => `${c.line} ${c.kind} ${c.from ?? ""}`.trim()),
      ["2 weakened never", "3 weakened never", "4 removed"],
    );
  });

  it("does not list a moved line, a reflowed one, or a rewording that keeps the strong word", () => {
    const now = [
      "# Rules",
      "-   **Only** the owner merges protected paths.",
      "- Never build any paths with `/`; use `node:path`.",
      "- Never put a session URL in a PR body.",
      "- Always run `kit check` before you push.",
      "- Do not edit `dist/` by hand.",
    ].join("\n");
    assert.deepEqual(ruleChanges("CLAUDE.md", HEAD, now), []);
  });

  it("lists every strong rule line of a deleted file", () => {
    assert.equal(ruleChanges("AGENTS.md", HEAD, null).length, 5);
  });
});
