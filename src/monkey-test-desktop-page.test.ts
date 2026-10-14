import assert from "node:assert/strict";
import { it } from "node:test";
import {
  PAGE_CHECK,
  PAGE_HELPERS,
  PAGE_MONITOR,
  TECHNICAL_ERROR_TEXT,
  pageStep,
} from "./monkey-test-desktop-page.js";

it("pageStep embeds the seed as an unsigned 32-bit integer", () => {
  assert.equal(pageStep(7), "return window.__kitMonkey.step(7);");
  assert.equal(pageStep(-1), "return window.__kitMonkey.step(4294967295);");
  assert.equal(pageStep(2 ** 32 + 5), "return window.__kitMonkey.step(5);");
});

it("PAGE_CHECK returns the serialized check result", () => {
  assert.match(PAGE_CHECK, /JSON\.stringify\(window\.__kitMonkey\.check\(\)\)/);
});

it("page code strings compile as async function bodies", () => {
  const AsyncFunction = Object.getPrototypeOf(async () => 0).constructor as new (
    body: string,
  ) => unknown;
  for (const code of [PAGE_MONITOR, PAGE_HELPERS, PAGE_CHECK, pageStep(3)]) {
    assert.doesNotThrow(() => new AsyncFunction(code));
  }
});

it("monitor installs once and helpers define check and step", () => {
  assert.match(PAGE_MONITOR, /if \(!w\.__kitMonkey\)/);
  assert.match(PAGE_HELPERS, /K\.check = /);
  assert.match(PAGE_HELPERS, /K\.step = /);
});

it("technical error text matches raw runtime errors", () => {
  const raw = [
    "invalid args `path` for command",
    "expected u32, got string",
    "missing field `id`",
    "serde_json error",
    "thread panicked at lib.rs",
    "called `Option::unwrap` on a None",
    "No such file (os error 2)",
    "Error at run (app.js:10:5)",
  ];
  for (const text of raw) assert.equal(TECHNICAL_ERROR_TEXT.test(text), true, text);
});

it("technical error text ignores friendly messages", () => {
  for (const text of ["Could not save. Try again.", "Your export was interrupted."]) {
    assert.equal(TECHNICAL_ERROR_TEXT.test(text), false, text);
  }
});
