import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KNOBS, knobsAsJson, formatKnobs } from "./knobs.js";

const ESC = String.fromCharCode(27); // ANSI sequences start with this byte

describe("knobs reference", () => {
  it("every knob is well-formed (name, kind, desc)", () => {
    for (const group of KNOBS) {
      assert.ok(group.title.length > 0);
      assert.ok(group.knobs.length > 0, `group ${group.title} is empty`);
      for (const k of group.knobs) {
        assert.ok(k.name.length > 0);
        assert.ok(k.kind === "env" || k.kind === "config");
        assert.ok(k.desc.length > 0, `${k.name} missing desc`);
      }
    }
  });

  it("includes the headline hidden knobs surfaced by the review", () => {
    const names = KNOBS.flatMap((g) => g.knobs.map((k) => k.name));
    for (const expected of [
      "KIT_MEMORY_REDACT",
      "KIT_SEMGREP_CONFIG",
      "[policy].default_mode",
      "[supply_chain].internal_scopes",
      "KIT_NO_HINTS",
    ]) {
      assert.ok(names.includes(expected), `expected knob ${expected}`);
    }
  });

  it("marks gate-bypassing knobs as dangerous", () => {
    const danger = KNOBS.flatMap((g) => g.knobs)
      .filter((k) => k.danger)
      .map((k) => k.name);
    for (const d of ["KIT_NON_INTERACTIVE", "KIT_ELEVATED", "KIT_PROD_OK"]) {
      assert.ok(danger.includes(d), `${d} should be flagged dangerous`);
    }
  });

  it("formatKnobs({color:false}) is plain text with no ANSI escape bytes", () => {
    const out = formatKnobs({ color: false });
    // knob names legitimately contain "[" so check for the ESC byte, not "[".
    assert.ok(!out.includes(ESC), "no ANSI escape bytes in no-color mode");
    assert.match(out, /KIT_SEMGREP_CONFIG/);
    assert.match(out, /Scanning/);
  });

  it("formatKnobs({color:true}) emits ANSI", () => {
    assert.ok(formatKnobs({ color: true }).includes(ESC));
  });

  it("knobsAsJson round-trips through JSON", () => {
    const j = JSON.parse(JSON.stringify(knobsAsJson()));
    assert.equal(j.length, KNOBS.length);
    assert.equal(j[0].knobs[0].name, KNOBS[0].knobs[0].name);
  });
});
