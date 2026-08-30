/**
 * Note on what is NOT tested here: the interactive TTY path (alternate screen, number-key tab
 * switching, restore on `q`/Ctrl-C/EOF) is verified by hand through a pty, because `script` — the
 * portable way to get a pty from a test — hangs when its own stdin is not a terminal, which would
 * hang CI rather than gate it. That path is where the real bug was: an earlier build entered the
 * alternate screen, let readline swallow the keypress, and never restored it, leaving the shell
 * apparently dead. The restore now runs from `process.once("exit")` and from SIGINT/SIGTERM, so it
 * cannot be skipped by an early return.
 *
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
    for (const tab of [
      "floor",
      "coverage",
      "standards",
      "keys",
      "memory",
      "triage",
      "machine",
      "proof",
    ] as const) {
      const rendered = renderTab(facts, tab, { interactive: false });
      const widths = new Set(
        rendered
          .split("\n")
           
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

/**
 * Eight tabs do not fit on one 66-column row, and `line()` truncates. Truncating the tab row would
 * hide the tabs past the cut — i.e. hide whole dimensions of the report behind a key nobody knows
 * to press — so the row wraps instead. Every tab must remain reachable, which is what this asserts.
 */
describe("the tab row", () => {
  it("keeps every tab visible by wrapping rather than truncating", () => {
    const facts = gatherUsage(mkdtempSync(join(tmpdir(), "kit-usage-tabs-")), homedir());
    const rendered = renderTab(facts, "floor", { interactive: false });
    const plain = rendered.replace(/\x1b\[[0-9;]*m/g, "");
    for (const label of [
      "1 Floor",
      "2 Coverage",
      "3 Standards",
      "4 Keys",
      "5 Memory",
      "6 Triage",
      "7 Machine",
      "8 Proof",
    ]) {
      assert.ok(plain.includes(label), `${label} must be reachable:\n${plain}`);
    }
  });
});
