import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { KIT_MCP_TOOLS } from "./mcp-server.js";

/**
 * Docs ↔ MCP-surface drift gate.
 *
 * MCP_TOOLS_REFERENCE.md and MCP_TOOLS_GUIDE.md once documented an entire tool
 * set that never shipped (`kit_configure`, `kit_adapter_*` — a design that was
 * written down and then diverged), and later missed real tools for a full
 * minor series. Same disease as the scope-needs no-op: a surface asserting
 * things its mechanism doesn't do, with no gate forcing sync.
 *
 * Two directions, both enforced:
 *   1. every real tool is documented (nothing ships undocumented);
 *   2. every `kit_*` name the docs mention IS a real tool (fiction is a build
 *      failure, not a doc bug someone finds a year later).
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const DOCS = ["docs/MCP_TOOLS_REFERENCE.md", "docs/MCP_TOOLS_GUIDE.md", "README.md"].map((f) => ({
  file: f,
  text: readFileSync(join(REPO_ROOT, f), "utf8"),
}));

/** Every `kit_*` token in a doc (tool-name shaped; excludes prose words). */
function mentionedTools(text: string): Set<string> {
  return new Set(text.match(/\bkit_[a-z][a-z0-9_]*\b/g) ?? []);
}

describe("docs ↔ MCP surface", () => {
  it("every registered MCP tool is documented in the reference AND the README table", () => {
    // Full coverage is required of the LISTING surfaces. The guide is
    // flow-oriented and only forbidden from fiction (next test) — forcing all
    // tool names into prose would be padding, not documentation.
    for (const doc of DOCS.filter((d) => d.file !== "docs/MCP_TOOLS_GUIDE.md")) {
      const mentioned = mentionedTools(doc.text);
      const missing = KIT_MCP_TOOLS.filter((t) => !mentioned.has(t));
      assert.deepEqual(
        missing,
        [],
        `${doc.file} does not mention: ${missing.join(", ")} — document the tool (or, if it was removed, update KIT_MCP_TOOLS first)`,
      );
    }
  });

  it("the docs mention no fictional tools", () => {
    const real = new Set(KIT_MCP_TOOLS);
    for (const doc of DOCS) {
      const fictional = [...mentionedTools(doc.text)].filter((t) => !real.has(t));
      assert.deepEqual(
        fictional,
        [],
        `${doc.file} documents tool(s) that do not exist: ${fictional.join(", ")}`,
      );
    }
  });

  it("the reference marks exactly the deprecated tools as deprecated", () => {
    // 6.0 removed the six deprecated tools, so the set is empty: no row may
    // carry a deprecation marker. When a future removal cycle starts, list the
    // newly-deprecated tools here again.
    const DEPRECATED: string[] = [];
    const ref = DOCS[0].text;
    const rows = ref.split("\n").filter((l) => l.startsWith("| `kit_"));
    for (const row of rows) {
      const name = /\| `(kit_[a-z0-9_]+)`/.exec(row)?.[1] ?? "";
      const marked = /[Dd]eprecated/.test(row);
      assert.equal(
        marked,
        DEPRECATED.includes(name),
        `${name}: deprecation marker ${marked ? "present but tool is not deprecated" : "missing"}`,
      );
    }
    assert.ok(rows.length >= KIT_MCP_TOOLS.length, "reference table lists every tool as a row");
  });
});
