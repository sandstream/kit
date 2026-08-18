import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { promptSelect, type PromptOption } from "./promptSelect.js";

const BACKENDS: PromptOption[] = [
  { value: "env", label: "env", hint: "process.env" },
  { value: "1password", label: "1Password", recommended: true },
  { value: "vault", label: "HashiCorp Vault" },
];

function fakeTTY() {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const output = new PassThrough();
  let printed = "";
  output.on("data", (chunk: Buffer) => {
    printed += chunk.toString();
  });
  return { input, output, printed: () => printed };
}

async function ask(typed: string | null, options = BACKENDS) {
  const io = fakeTTY();
  const answered = promptSelect("Secret backend?", options, io);
  await new Promise((r) => setImmediate(r));
  if (typed === null) io.input.end();
  else io.input.write(`${typed}\n`);
  return { chosen: await answered, printed: io.printed() };
}

describe("promptSelect", () => {
  it("marks the recommended option and numbers the rest", async () => {
    const { printed } = await ask("");
    assert.match(printed, /Secret backend\?/);
    assert.match(printed, /\[1\] {3}env {2}— process\.env/);
    assert.match(printed, /\[2\] \* 1Password/);
    assert.match(printed, /default 2/);
  });

  it("resolves a typed index", async () => {
    assert.equal((await ask("3")).chosen, "vault");
  });

  it("resolves a typed value, case-insensitively", async () => {
    assert.equal((await ask("VAULT")).chosen, "vault");
  });

  it("bare enter takes the recommended option", async () => {
    assert.equal((await ask("")).chosen, "1password");
  });

  it("falls back and says so on an unrecognised answer", async () => {
    const { chosen, printed } = await ask("mongodb");
    assert.equal(chosen, "1password");
    assert.match(printed, /Invalid choice "mongodb" — using default/);
  });

  it("falls back to the first option when none is recommended", async () => {
    assert.equal((await ask("", [{ value: "env", label: "env" }])).chosen, "env");
  });

  it("Ctrl+D falls back rather than crashing, and names what it chose", async () => {
    // Regression: the rejected readline question escaped as an AbortError and ended the
    // whole command on a node stack trace at the moment the user tried to back out.
    const { chosen, printed } = await ask(null);
    assert.equal(chosen, "1password");
    assert.match(printed, /No answer — using "1password"/);
  });

  it("returns the recommended option without asking when there is no TTY", async () => {
    const input = new PassThrough(); // no isTTY
    assert.equal(await promptSelect("Secret backend?", BACKENDS, { input, output: new PassThrough() }), "1password");
  });

  it("returns empty string for an empty option list", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    assert.equal(await promptSelect("Secret backend?", [], { input, output: new PassThrough() }), "");
  });
});
