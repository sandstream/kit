import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readThroughCarriers, type CommandReader } from "./gate-bash-carriers.js";

// A reader for a made-up `probe` command: it reports the arguments and assignments it saw.
const PROBE: CommandReader<string> = {
  isTarget: (word) => word === "probe",
  read: (_head, args, env) => (args.includes("--hit") ? [...env, ...args].join(" ") : null),
};
const read = (command: string | string[]) => readThroughCarriers(command, PROBE);

describe("gate-bash carriers", () => {
  for (const command of [
    "probe --hit",
    "sh -c 'probe --hit'",
    "env A=1 probe --hit",
    "sudo -u x probe --hit",
    "echo $(probe --hit)",
    "npm exec -- probe --hit",
    'powershell -Command "probe --hit"',
    "true && probe --hit",
  ])
    it(`reaches the target: ${command}`, () => assert.ok(read(command)));

  it("keeps the assignments before the target", () => {
    assert.equal(read("X=1 probe --hit"), "X=1 --hit");
  });

  for (const command of ["probe", "echo probe --hit", "git commit -m 'probe --hit'", ""])
    it(`does not run data: ${JSON.stringify(command)}`, () => assert.equal(read(command), null));

  it("takes one argv", () => {
    assert.equal(read(["probe", "--hit"]), "--hit");
  });
});
