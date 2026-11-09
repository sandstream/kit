import assert from "node:assert/strict";
import { it } from "node:test";
import { cmdTriage } from "./triage.js";

for (const name of ["constructor", "toString", "__proto__"]) {
  it(`rejects inherited object name ${name} as a triage command`, async (t) => {
    const previous = process.argv;
    process.argv = [process.execPath, "kit", "triage", name];
    t.after(() => {
      process.argv = previous;
    });
    const errors: string[] = [];
    t.mock.method(console, "error", (...args: unknown[]) => errors.push(args.join(" ")));
    assert.equal(await cmdTriage(), false);
    assert.match(errors.join("\n"), /Unknown triage type/);
  });
}
