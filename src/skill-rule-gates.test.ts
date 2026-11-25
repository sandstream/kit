import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findUngatedSkillRules, skillRuleGateRows } from "./skill-rule-gates.js";
import { checkStandardsPlugins, loadStandardPlugins } from "./standards-plugins.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const GUID_RULE = [
  "[standard]",
  'id = "no-guid-newguid"',
  'title = "Use a domain primitive (ProductId.New()), not Guid.NewGuid()"',
  'because = "ids are domain primitives; call ProductId.New()"',
  'severity = "fail"',
  "match = 'Guid\\.NewGuid\\(\\)'",
  'exts = [".cs"]',
].join("\n");

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-skillrules-"));
  for (const [rel, text] of Object.entries(files)) {
    const parts = rel.split("/");
    mkdirSync(join(dir, ...parts.slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, ...parts), text);
  }
  return dir;
}

const SKILL = [
  "# Domain rules",
  "Never call `Guid.NewGuid()`; use `ProductId.New()`.",
  "Always name events without the `*Event` suffix.",
  "The `skills` folder holds this file.",
  "Run `dotnet test` before you push.",
].join("\n");

describe("skill rules without a gate", () => {
  it("names the rule lines whose code no standards rule checks, in Claude and Codex skills", () => {
    const dir = repo({
      ".kit/standards.d/no-guid.toml": GUID_RULE,
      ".claude/skills/domain/SKILL.md": SKILL,
      ".agents/skills/time/SKILL.md": "Do not use `DateTime.Now`; inject a clock.\n",
    });
    try {
      const { plugins } = loadStandardPlugins(dir, [".kit/standards.d"]);
      const found = findUngatedSkillRules(dir, plugins).map(
        (u) => `${u.file}:${u.line} ${u.token}`,
      );
      assert.deepEqual(found.sort(), [
        ".agents/skills/time/SKILL.md:1 DateTime.Now",
        ".claude/skills/domain/SKILL.md:3 *Event",
      ]);
    } finally {
      rmTemp(dir);
    }
  });

  it("counts a rule as gated when a standards rule's title names it", () => {
    const dir = repo({
      ".kit/standards.d/no-guid.toml": GUID_RULE,
      ".kit/standards.d/event.toml": [
        "[standard]",
        'id = "no-event-suffix"',
        'title = "Events inheriting EventBase have no Event suffix"',
        "match = 'class\\s+\\w+Event\\s*:\\s*EventBase'",
      ].join("\n"),
      ".claude/skills/domain/SKILL.md": SKILL,
    });
    try {
      const { plugins } = loadStandardPlugins(dir, [".kit/standards.d"]);
      assert.deepEqual(findUngatedSkillRules(dir, plugins), []);
      assert.deepEqual(skillRuleGateRows(dir, plugins), []);
    } finally {
      rmTemp(dir);
    }
  });

  it("adds one warning row to the plugin results, never a failure", () => {
    const dir = repo({ ".claude/skills/domain/SKILL.md": SKILL });
    try {
      const rows = checkStandardsPlugins({ cwd: dir, language: "csharp" });
      const row = rows.find((r) => r.name === "skill rules without a gate");
      assert.equal(row?.status, "warn");
      assert.deepEqual(row?.files, [
        ".claude/skills/domain/SKILL.md:2 (Guid.NewGuid())",
        ".claude/skills/domain/SKILL.md:2 (ProductId.New())",
        ".claude/skills/domain/SKILL.md:3 (*Event)",
      ]);
    } finally {
      rmTemp(dir);
    }
  });

  it("prints a rule's because with each failure", () => {
    const dir = repo({
      ".kit/standards.d/no-guid.toml": GUID_RULE,
      "src/Order.cs": "public class Order { public Guid Id = Guid.NewGuid(); }\n",
    });
    try {
      const rows = checkStandardsPlugins({ cwd: dir, language: "csharp" });
      const row = rows.find((r) => r.name === "plugin: no-guid-newguid");
      assert.equal(row?.status, "fail");
      assert.match(
        row?.detail ?? "",
        /Because: ids are domain primitives; call ProductId\.New\(\)$/,
      );
    } finally {
      rmTemp(dir);
    }
  });
});
