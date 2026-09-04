import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { parseInstallCommand } from "./install-gate.js";
import { findSecrets, redactSecrets } from "./utils/redactSecrets.js";

const lower = [..."abcdefghijklmnopqrstuvwxyz"];
const packageTail = [..."abcdefghijklmnopqrstuvwxyz0123456789-_"].map(String);
const tokenChars = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"].map(
  String,
);

const packageName = fc
  .tuple(fc.constantFrom(...lower), fc.array(fc.constantFrom(...packageTail), { maxLength: 30 }))
  .map(([head, tail]) => head + tail.join(""));

const semver = fc
  .tuple(
    fc.integer({ min: 0, max: 999 }),
    fc.integer({ min: 0, max: 999 }),
    fc.integer({ min: 0, max: 999 }),
  )
  .map((parts) => parts.join("."));

describe("security property tests", () => {
  it("parses arbitrary shell input deterministically without throwing", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (command) => {
        assert.deepEqual(parseInstallCommand(command), parseInstallCommand(command));
      }),
      { numRuns: 2_000 },
    );
  });

  it("retains exact package versions for every supported npm installer", () => {
    const installer = fc.constantFrom(
      "npm install",
      "npm i",
      "npm add",
      "pnpm add",
      "yarn add",
      "bun add",
    );
    fc.assert(
      fc.property(installer, packageName, semver, (prefix, name, version) => {
        const probe = parseInstallCommand(`${prefix} ${name}@${version}`);
        assert.equal(probe.isInstall, true);
        assert.deepEqual(probe.refs, [`npm:${name}@${version}`]);
        assert.deepEqual(probe.unverifiable, []);
      }),
      { numRuns: 1_000 },
    );
  });

  it("redacts caller-known values and recognized API keys without returning raw bytes", () => {
    const secret = fc
      .array(fc.constantFrom(...tokenChars), { minLength: 40, maxLength: 80 })
      .map((xs) => xs.join(""));
    fc.assert(
      fc.property(secret, (value) => {
        const knownOutput = redactSecrets(`before:${value}:after`, [value]);
        assert.ok(!knownOutput.includes(value));

        const apiKey = `sk-${value}`;
        const output = redactSecrets(`key=${apiKey}`);
        assert.ok(!output.includes(apiKey));
        assert.ok(!JSON.stringify(findSecrets(apiKey)).includes(apiKey));
      }),
      { numRuns: 1_000 },
    );
  });

  it("makes redaction idempotent for arbitrary text", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 1_000 }), (value) => {
        const once = redactSecrets(value);
        assert.equal(redactSecrets(once), once);
      }),
      { numRuns: 2_000 },
    );
  });
});
