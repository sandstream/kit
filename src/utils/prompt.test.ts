import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { promptConfirm } from "./prompt.js";

function terminal(t: TestContext) {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  t.after(() => {
    if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor);
    else Reflect.deleteProperty(process.stdin, "isTTY");
    process.stdin.pause();
  });
}

for (const [answer, expected] of [
  ["\n", false],
  ["not-yes\n", false],
  ["NO\n", false],
  ["YES\n", true],
  ["y\n", true],
] as const) {
  it(`confirmation ${JSON.stringify(answer)} produces ${expected}`, async (t) => {
    terminal(t);
    const result = promptConfirm("Confirm: ", 1000, false);
    process.stdin.emit("data", answer);
    assert.equal(await result, expected);
  });
}

it("confirmation respects the default only for blank input or timeout", async (t) => {
  terminal(t);
  const blank = promptConfirm("Confirm: ", 1000, true);
  process.stdin.emit("data", "\n");
  assert.equal(await blank, true);
  const invalid = promptConfirm("Confirm: ", 1000, true);
  process.stdin.emit("data", "arbitrary\n");
  assert.equal(await invalid, false);
  assert.equal(await promptConfirm("Confirm: ", 10, false), false);
});

it("confirmation on EOF refuses and does not remove another reader's listeners", async (t) => {
  terminal(t);
  const listener = () => undefined;
  process.stdin.on("data", listener);
  t.after(() => process.stdin.removeListener("data", listener));
  const result = promptConfirm("Confirm: ", 20, false);
  process.stdin.emit("end");
  assert.equal(await result, false);
  assert.ok(process.stdin.listeners("data").includes(listener));
});
