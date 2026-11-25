/**
 * A declarative `.kit/standards.d` rule matches one line at a time, and the docs say so.
 *
 * A team that moves an "architecture test" out of an agent skill into a rule (no `Event` suffix on
 * a class that inherits `EventBase`) gets no finding when the declaration is split across two
 * lines. That is the design (a regex over lines, cheap and deterministic), but the reference
 * described only forbid and require mode, so the rule read as covering more than it does. If the
 * matcher ever spans lines, the first test fails and the docs must change with it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluatePluginFindings, loadStandardPlugins } from "./standards-plugins.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("declarative standards rules are line-based", () => {
  it("find a one-line declaration and not the same declaration split across lines", () => {
    const repo = mkdtempSync(join(tmpdir(), "kit-splugin-lines-"));
    try {
      mkdirSync(join(repo, ".kit", "standards.d"), { recursive: true });
      mkdirSync(join(repo, "src"));
      writeFileSync(
        join(repo, ".kit", "standards.d", "event-suffix.toml"),
        [
          "[standard]",
          'id = "no-event-suffix"',
          'title = "Events inheriting EventBase have no Event suffix"',
          "match = 'class\\s+\\w+Event\\s*:\\s*EventBase'",
          'exts = [".cs"]',
        ].join("\n"),
      );
      writeFileSync(join(repo, "src", "One.cs"), "public class PlacedEvent : EventBase { }\n");
      writeFileSync(
        join(repo, "src", "Split.cs"),
        "public class ShippedEvent\n    : EventBase { }\n",
      );
      const { plugins } = loadStandardPlugins(repo, [join(".kit", "standards.d")]);
      assert.equal(plugins.length, 1);
      const files = evaluatePluginFindings(repo, plugins[0]!).map((f) => f.file);
      assert.deepEqual(files, ["src/One.cs"]);
    } finally {
      rmTemp(repo);
    }
  });

  it("the command reference and the README say rules match one line at a time", () => {
    const commands = readFileSync(resolve(root, "docs", "COMMANDS.md"), "utf8");
    const readme = readFileSync(resolve(root, "README.md"), "utf8");
    assert.match(commands, /`match` is tested one line at a time/);
    assert.match(readme, /plugins match one line at a time/);
  });
});
