import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateBashCompletion, generateZshCompletion, generateFishCompletion, generateCompletions } from "./completions.js";

describe("generateBashCompletion", () => {
  it("outputs non-empty bash script", () => {
    const script = generateBashCompletion();
    assert(script.length > 0);
    assert(script.includes("_kit_completions"));
  });

  it("includes key commands", () => {
    const script = generateBashCompletion();
    assert(script.includes("check"));
    assert(script.includes("add"));
    assert(script.includes("ci"));
    assert(script.includes("mcp"));
    assert(script.includes("secrets"));
  });

  it("includes adapter names", () => {
    const script = generateBashCompletion();
    assert(script.includes("neon/db"));
    assert(script.includes("stripe/payments"));
    assert(script.includes("supabase/db"));
  });

  it("includes complete directive", () => {
    const script = generateBashCompletion();
    assert(script.includes("complete -F _kit_completions kit"));
  });
});

describe("generateZshCompletion", () => {
  it("outputs non-empty zsh script", () => {
    const script = generateZshCompletion();
    assert(script.length > 0);
    assert(script.includes("#compdef kit"));
  });

  it("includes key commands", () => {
    const script = generateZshCompletion();
    assert(script.includes("check"));
    assert(script.includes("add"));
    assert(script.includes("ci"));
  });

  it("includes adapter completions", () => {
    const script = generateZshCompletion();
    assert(script.includes("neon/db"));
    assert(script.includes("stripe/payments"));
  });
});

describe("generateFishCompletion", () => {
  it("outputs non-empty fish script", () => {
    const script = generateFishCompletion();
    assert(script.length > 0);
    assert(script.includes("complete -c kit"));
  });

  it("includes key commands", () => {
    const script = generateFishCompletion();
    assert(script.includes("check"));
    assert(script.includes("add"));
    assert(script.includes("ci"));
  });

  it("includes adapter completions", () => {
    const script = generateFishCompletion();
    assert(script.includes("neon/db"));
    assert(script.includes("stripe/payments"));
  });

  it("includes global flags", () => {
    const script = generateFishCompletion();
    // Fish uses -l flag-name syntax (without --)
    assert(script.includes("non-interactive"));
    assert(script.includes("-l json") || script.includes("--json") || script.includes("json"));
  });
});

describe("generateCompletions", () => {
  it("returns bash script for bash", () => {
    const s = generateCompletions("bash");
    assert(s !== null);
    assert(s!.includes("_kit_completions"));
  });

  it("returns zsh script for zsh", () => {
    const s = generateCompletions("zsh");
    assert(s !== null);
    assert(s!.includes("#compdef kit"));
  });

  it("returns fish script for fish", () => {
    const s = generateCompletions("fish");
    assert(s !== null);
    assert(s!.includes("complete -c kit"));
  });

  it("returns null for unknown shell", () => {
    assert.equal(generateCompletions("powershell"), null);
    assert.equal(generateCompletions(""), null);
  });
});
