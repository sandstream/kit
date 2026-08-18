import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  parseMultiSelectAnswer,
  promptMultiSelect,
  type MultiSelectOption,
} from "./promptMultiSelect.js";

const OPTIONS: MultiSelectOption[] = [
  { value: "postgres", label: "postgres", hint: "found in this repo", preselected: true },
  { value: "redis", label: "redis" },
  { value: "sentry", label: "sentry", hint: "you use it elsewhere" },
];

describe("parseMultiSelectAnswer", () => {
  it("empty input keeps the preselected set", () => {
    assert.deepEqual(parseMultiSelectAnswer("", OPTIONS), { picked: ["postgres"], unknown: [] });
  });

  it("whitespace-only input is the same as empty", () => {
    assert.deepEqual(parseMultiSelectAnswer("   \t ", OPTIONS), {
      picked: ["postgres"],
      unknown: [],
    });
  });

  it("empty input with nothing preselected picks nothing", () => {
    assert.deepEqual(parseMultiSelectAnswer("", [{ value: "redis", label: "redis" }]), {
      picked: [],
      unknown: [],
    });
  });

  it("'none' selects nothing, overriding the preselected set", () => {
    assert.deepEqual(parseMultiSelectAnswer("none", OPTIONS), { picked: [], unknown: [] });
  });

  it("'NONE' is accepted case-insensitively", () => {
    assert.deepEqual(parseMultiSelectAnswer(" NONE ", OPTIONS), { picked: [], unknown: [] });
  });

  it("resolves 1-based indices", () => {
    assert.deepEqual(parseMultiSelectAnswer("1,3", OPTIONS), {
      picked: ["postgres", "sentry"],
      unknown: [],
    });
  });

  it("accepts space, comma and mixed separators", () => {
    assert.deepEqual(parseMultiSelectAnswer("1 3", OPTIONS).picked, ["postgres", "sentry"]);
    assert.deepEqual(parseMultiSelectAnswer("1, 3", OPTIONS).picked, ["postgres", "sentry"]);
    assert.deepEqual(parseMultiSelectAnswer(" 1 ,3 ", OPTIONS).picked, ["postgres", "sentry"]);
  });

  it("resolves value names case-insensitively", () => {
    assert.deepEqual(parseMultiSelectAnswer("SENTRY redis", OPTIONS).picked, ["sentry", "redis"]);
  });

  it("mixes indices and names in one answer", () => {
    assert.deepEqual(parseMultiSelectAnswer("2 sentry", OPTIONS).picked, ["redis", "sentry"]);
  });

  it("keeps the typed order, not the option order", () => {
    assert.deepEqual(parseMultiSelectAnswer("3,1", OPTIONS).picked, ["sentry", "postgres"]);
  });

  it("dedupes an option named twice (index + name)", () => {
    assert.deepEqual(parseMultiSelectAnswer("3 sentry 3", OPTIONS).picked, ["sentry"]);
  });

  it("an explicit pick replaces the preselected set rather than adding to it", () => {
    // Typing "2" means "redis, and only redis" — postgres was ticked but not typed.
    assert.deepEqual(parseMultiSelectAnswer("2", OPTIONS).picked, ["redis"]);
  });

  it("reports an out-of-range index as unknown instead of clamping", () => {
    assert.deepEqual(parseMultiSelectAnswer("9", OPTIONS), { picked: [], unknown: ["9"] });
  });

  it("treats 0 as unknown (the list is 1-based)", () => {
    assert.deepEqual(parseMultiSelectAnswer("0", OPTIONS), { picked: [], unknown: ["0"] });
  });

  it("reports an unrecognised name as unknown", () => {
    assert.deepEqual(parseMultiSelectAnswer("mongodb", OPTIONS), {
      picked: [],
      unknown: ["mongodb"],
    });
  });

  it("a digit-prefixed token is unknown, never a silent pick of that index", () => {
    // "3x" must not become option 3 — a near-miss answer must not turn into a yes.
    assert.deepEqual(parseMultiSelectAnswer("3x", OPTIONS), { picked: [], unknown: ["3x"] });
  });

  it("keeps the good picks from an answer that also holds junk", () => {
    assert.deepEqual(parseMultiSelectAnswer("1 mongodb sentry", OPTIONS), {
      picked: ["postgres", "sentry"],
      unknown: ["mongodb"],
    });
  });

  it("an empty option list turns every token into unknown", () => {
    assert.deepEqual(parseMultiSelectAnswer("1 redis", []), {
      picked: [],
      unknown: ["1", "redis"],
    });
  });
});

describe("promptMultiSelect", () => {
  // The whole reason this helper exists next to promptSelect: "nobody is here to answer" must
  // read as null, so a service is never enabled on an agent's or CI's behalf. isTTY is forced
  // rather than asserted because the runner's stdin differs between `npm test` and a bare
  // `node --test` from a terminal — the contract under test must not depend on that.
  async function withoutTTY<T>(fn: () => Promise<T>): Promise<T> {
    const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      return await fn();
    } finally {
      if (original) Object.defineProperty(process.stdin, "isTTY", original);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  }

  it("returns null — not a default — when stdin is not a TTY", async () => {
    assert.equal(await withoutTTY(() => promptMultiSelect("Which services?", OPTIONS)), null);
  });

  it("returns null even when every option is preselected", async () => {
    const allTicked = OPTIONS.map((o) => ({ ...o, preselected: true }));
    assert.equal(await withoutTTY(() => promptMultiSelect("Which services?", allTicked)), null);
  });

  it("returns null before it looks at an empty option list", async () => {
    // Order matters: the no-TTY answer is null even when the list is empty (which at a TTY
    // would answer []), so "unanswered" and "answered with nothing" stay distinguishable.
    assert.equal(await withoutTTY(() => promptMultiSelect("Which services?", [])), null);
  });
});

describe("promptMultiSelect at a TTY", () => {
  /** A fake terminal: `input` claims isTTY so the question is actually put. */
  function fakeTTY() {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = new PassThrough();
    let printed = "";
    output.on("data", (chunk: Buffer) => {
      printed += chunk.toString();
    });
    return { input, output, printed: () => printed };
  }

  async function ask(typed: string | null, options = OPTIONS) {
    const io = fakeTTY();
    const answered = promptMultiSelect("Which services?", options, io);
    // The question is written synchronously before readline waits, but the answer must land
    // after that — one macrotask is enough and keeps the test free of timers.
    await new Promise((r) => setImmediate(r));
    if (typed === null) io.input.end();
    else io.input.write(`${typed}\n`);
    return { picked: await answered, printed: io.printed() };
  }

  it("prints the question, the numbering and the ticks", async () => {
    const { printed } = await ask("");
    assert.match(printed, /Which services\?/);
    assert.match(printed, /\[1\] \(x\) postgres {2}— found in this repo/);
    assert.match(printed, /\[2\] \( \) redis/);
    assert.match(printed, /\[3\] \( \) sentry {2}— you use it elsewhere/);
  });

  it("resolves what the user typed", async () => {
    assert.deepEqual((await ask("2, sentry")).picked, ["redis", "sentry"]);
  });

  it("bare enter keeps the ticked set", async () => {
    assert.deepEqual((await ask("")).picked, ["postgres"]);
  });

  it("'none' answers with nothing — an answer, not a non-answer", async () => {
    assert.deepEqual((await ask("none")).picked, []);
  });

  it("names the tokens it ignored", async () => {
    const { picked, printed } = await ask("1 mongodb 3x");
    assert.deepEqual(picked, ["postgres"]);
    assert.match(printed, /Ignoring unknown choice "mongodb"/);
    assert.match(printed, /Ignoring unknown choice "3x"/);
  });

  it("Ctrl+D (closed input) returns null instead of throwing", async () => {
    // Regression: the rejected readline question used to escape as an AbortError and end
    // `kit init` on a node stack trace at the exact moment the user tried to back out.
    const { picked, printed } = await ask(null);
    assert.equal(picked, null);
    assert.match(printed, /No answer — leaving the offered services out/);
  });

  it("answers [] for an empty option list without asking", async () => {
    assert.deepEqual((await ask("", [])).picked, []);
  });
});
