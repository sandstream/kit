import assert from "node:assert/strict";
import { it } from "node:test";
import {
  falsePositiveMarkSchema,
  findingEvidenceSchema,
  locateSecretMatches,
} from "./finding-evidence.js";
import { findSecretMatches } from "./utils/redactSecrets.js";

it("requires file, positive line and pattern in each finding", () => {
  const evidence = { file: "settings.ts", line: 2, pattern: "keyed-secret" };
  assert.deepEqual(findingEvidenceSchema.parse(evidence), evidence);
  for (const incomplete of [
    { ...evidence, file: undefined },
    { ...evidence, line: undefined },
    { ...evidence, pattern: undefined },
    { ...evidence, line: 0 },
    { ...evidence, line: 2.5 },
    { ...evidence, pattern: "" },
  ]) {
    assert.equal(findingEvidenceSchema.safeParse(incomplete).success, false);
  }
});

it("requires a reason for a false-positive mark", () => {
  assert.equal(falsePositiveMarkSchema.safeParse({}).success, false);
  assert.equal(falsePositiveMarkSchema.safeParse({ reason: "        " }).success, false);
  assert.deepEqual(falsePositiveMarkSchema.parse({ reason: " Synthetic test input " }), {
    reason: "Synthetic test input",
  });
});

it("locates repeated credential-shaped fixtures across CRLF lines", () => {
  const fixture = ["sk_", "test_", "M".repeat(24)].join("");
  const text = `// start\r\n${fixture}\r\n\r\n${fixture}\r\n`;
  const matches = locateSecretMatches("settings.ts", text, findSecretMatches(text));
  assert.deepEqual(
    matches.map(({ evidence }) => evidence),
    [
      { file: "settings.ts", line: 2, pattern: "stripe-key" },
      { file: "settings.ts", line: 4, pattern: "stripe-key" },
    ],
  );
  assert.equal(JSON.stringify(matches).includes(fixture), false);
});
