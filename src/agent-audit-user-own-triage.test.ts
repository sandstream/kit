import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runUserAgentAudit, surfaceRows } from "./agent-audit-user.js";
import { installBundledTriageSkill } from "./triage.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

/** kit's own copy, as the package ships it: its detection regexes look like what they detect. */
const BUNDLED_PLUGIN_SCAN = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "skills",
  "triage",
  "scripts",
  "plugin_scan.py",
);
const SHOWN = "~/.claude/skills/triage/scripts/plugin_scan.py";
const flagged = (rows: { name: string }[]) =>
  rows.some((r) => r.name === `malware-shaped user skill ${SHOWN}`);

describe("surfaceRows: kit's own triage skill copy is not malware-shaped", () => {
  it("passes the bundled bytes, and flags the same file with one line added", () => {
    const body = readFileSync(BUNDLED_PLUGIN_SCAN, "utf8");
    assert.equal(flagged(surfaceRows(SHOWN, "user skill", body)), false, "bundled copy");
    const edited = `${body}\n# local edit\n`;
    assert.equal(flagged(surfaceRows(SHOWN, "user skill", edited)), true, "modified copy");
  });
});

describe("runUserAgentAudit with the triage skill kit installed", () => {
  it("does not flag the installed copy, and flags it once it is modified", async () => {
    const home = mkdtempSync(join(tmpdir(), "kit-user-own-triage-"));
    const root = mkdtempSync(join(tmpdir(), "kit-user-own-triage-root-"));
    try {
      const dir = join(home, ".claude", "skills", "triage");
      assert.equal(await installBundledTriageSkill(dir), true);
      assert.equal(flagged(runUserAgentAudit(root, home)), false, "installed copy");
      appendFileSync(join(dir, "scripts", "plugin_scan.py"), "\n# planted\n");
      assert.equal(flagged(runUserAgentAudit(root, home)), true, "modified copy");
    } finally {
      rmTemp(home);
      rmTemp(root);
    }
  });
});
