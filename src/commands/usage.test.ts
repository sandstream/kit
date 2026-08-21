/**
 * The renderer pads around ANSI escapes, so the box geometry is arithmetic that can be wrong — and
 * was: the first build produced rows of 63, 70 and 80 visible columns because the header padding
 * counted escape bytes and six tabs overflowed the frame. A report that looks broken does not get
 * read, so the width is pinned as a property across every tab.
 *
 * The second test pins the honesty of the Proof tab: before `--prove` has run, it must say so
 * rather than render as though the controls had held.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { gatherUsage } from "../usage-report.js";
import { renderTab } from "./usage.js";

describe("renderTab", () => {
  const facts = gatherUsage(mkdtempSync(join(tmpdir(), "kit-usage-render-")), homedir());

  it("draws a box whose every line is the same visible width", () => {
    for (const tab of ["floor", "coverage", "memory", "triage", "machine", "proof"] as const) {
      const rendered = renderTab(facts, tab, { interactive: false });
      const widths = new Set(
        rendered
          .split("\n")
          // eslint-disable-next-line no-control-regex
          .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").length),
      );
      assert.equal(
        widths.size,
        1,
        `tab ${tab} rendered ragged widths: ${[...widths].join(", ")}\n${rendered}`,
      );
    }
  });

  it("tells the operator the proof has not been run rather than implying it passed", () => {
    const rendered = renderTab(facts, "proof", { interactive: false });
    assert.match(rendered, /not run/);
    assert.doesNotMatch(rendered, /every control held/);
  });
});
