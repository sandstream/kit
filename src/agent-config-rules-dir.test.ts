import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_TARGETS, KIT_BLOCK_BEGIN, rulesFileIn, writeAgentConfig } from "./agent-config.js";

const cline = AGENT_TARGETS.filter((t) => t.agent === "Cline");

describe("the Cline rules block when .clinerules is a folder", () => {
  it("writes .clinerules/kit.md next to the folder kit's own Cline gate creates", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "kit-clinerules-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, ".clinerules", "hooks"), { recursive: true });
    const [result] = await writeAgentConfig(dir, cline);
    assert.equal(result.action, "created", result.detail);
    assert.equal(result.file, join(".clinerules", "kit.md"));
    assert.ok(readFileSync(join(dir, ".clinerules", "kit.md"), "utf8").includes(KIT_BLOCK_BEGIN));
    const [again] = await writeAgentConfig(dir, cline);
    assert.equal(again.action, "unchanged");
  });

  it("keeps a .clinerules file, and an absent one, as the file", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "kit-clinerules-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    assert.equal(rulesFileIn(dir, ".clinerules"), ".clinerules");
    writeFileSync(join(dir, ".clinerules"), "# rules\n");
    assert.equal(rulesFileIn(dir, ".clinerules"), ".clinerules");
  });
});
