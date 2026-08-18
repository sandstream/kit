import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as readline from "node:readline/promises";
import { PassThrough } from "node:stream";
import { askQuestion } from "./askQuestion.js";

function rlOver(input: PassThrough) {
  const output = new PassThrough();
  output.resume(); // drain the prompt text; nothing here asserts on it
  return readline.createInterface({ input, output });
}

describe("askQuestion", () => {
  it("returns the line the user typed, verbatim", async () => {
    const input = new PassThrough();
    const asked = askQuestion(rlOver(input), "Choose: ");
    await new Promise((r) => setImmediate(r));
    input.write("  vault  \n");
    // Untrimmed on purpose: trimming is the caller's rule, and promptMultiSelect's
    // "empty means keep the ticked set" needs to see the difference.
    assert.equal(await asked, "  vault  ");
  });

  it("returns an empty string for a bare enter — an answer, not a non-answer", async () => {
    const input = new PassThrough();
    const asked = askQuestion(rlOver(input), "Choose: ");
    await new Promise((r) => setImmediate(r));
    input.write("\n");
    assert.equal(await asked, "");
  });

  it("returns null when the input closes with the question unanswered", async () => {
    // The hang case: rl.question never settles once the input is gone, so this has to be
    // won by the close event rather than caught.
    const input = new PassThrough();
    const asked = askQuestion(rlOver(input), "Choose: ");
    await new Promise((r) => setImmediate(r));
    input.end();
    assert.equal(await asked, null);
  });

  it("returns null when the question is aborted, the way Ctrl+D aborts it", async () => {
    const input = new PassThrough();
    const rl = rlOver(input);
    const controller = new AbortController();
    // readline rejects an aborted question with an AbortError — the same rejection a real
    // Ctrl+D produces on a TTY, which used to escape as an unhandled stack trace.
    // A stand-in interface whose question carries the abort signal — askQuestion itself takes
    // no signal, so this is the only way to exercise the rejection path it has to swallow.
    const aborting = {
      question: (p: string) => rl.question(p, { signal: controller.signal }),
      once: () => {},
    } as unknown as readline.Interface;
    const asked = askQuestion(aborting, "Choose: ");
    await new Promise((r) => setImmediate(r));
    controller.abort();
    assert.equal(await asked, null);
    rl.close();
  });
});
