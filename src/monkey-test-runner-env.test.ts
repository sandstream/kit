import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  expectedReasonState,
  parseEnvOutput,
  runnerEnvironment,
} from "./monkey-test-runner-env.js";

describe("monkey-test runner environment", () => {
  it("parses JSON and dotenv output without accepting invalid keys", () => {
    assert.deepEqual(parseEnvOutput('{"TOKEN":"value","PORT":42,"DROP":false}'), {
      TOKEN: "value",
      PORT: "42",
    });
    assert.deepEqual(parseEnvOutput('TOKEN="quoted"\nBAD KEY=value\n# comment\n'), {
      TOKEN: "quoted",
    });
  });

  it("binds evidence to a run id and requires a specific skip reason", () => {
    const env = runnerEnvironment({ linkDepth: 4 }, "run-123");
    assert.equal(env.MONKEY_RUN_ID, "run-123");
    assert.equal(env.MONKEY_LINK_DEPTH, "4");
    assert.equal(expectedReasonState({ expectedReason: "too short" }).valid, false);
    assert.equal(
      expectedReasonState({ expectedReason: "accepted until ticket 42 closes" }).valid,
      true,
    );
  });

  it("uses dotenv quoting, export, comments, equals and multiline semantics", () => {
    assert.deepEqual(
      parseEnvOutput(
        [
          "export TOKEN='value=with=equals'",
          'export LABEL="quoted # text" # comment',
          "PLAIN = value # comment",
          'MULTILINE="first\nsecond"',
          "PRICE='USD $ 10'",
          "TOKEN=last-value",
        ].join("\r\n"),
      ),
      {
        TOKEN: "last-value",
        LABEL: "quoted # text",
        PLAIN: "value",
        MULTILINE: "first\nsecond",
        PRICE: "USD $ 10",
      },
    );
  });

  it("filters JSON env keys consistently and rejects malformed structured exports", () => {
    assert.deepEqual(
      parseEnvOutput('{"VALID":"yes","BAD KEY":"no","ARRAY":[],"NESTED":{},"N":7}'),
      {
        VALID: "yes",
        N: "7",
      },
    );
    assert.throws(() => parseEnvOutput('["not an env object"]'));
    assert.throws(() => parseEnvOutput('{"incomplete":'));
  });
});

describe("monkey-test literal environment safety", () => {
  it("never quotes invalid provider values in parser errors", () => {
    const secret = "syntheticParserSecret123456789";
    for (const output of [
      `{"KEY":"${secret}" trailing invalid JSON`,
      JSON.stringify({ KEY: `${secret}\0tail` }),
      `export KEY="${secret}\0tail"\n`,
      `KEY: ${secret}\n`,
      `KEY=\${${secret}}\n`,
    ]) {
      assert.throws(
        () => parseEnvOutput(output),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(!error.message.includes(secret));
          return true;
        },
      );
    }
  });

  it("accepts literal dotenv whitespace, BOM, comments and quoted newlines", () => {
    assert.deepEqual(
      parseEnvOutput(
        [
          "\uFEFF# literal comments may describe $REFERENCES and \\r escapes",
          'export LABEL = "seed # label" \t',
          "EMPTY=  ",
          'MULTILINE="first\\nsecond"  ',
          "LITERAL='first\\nsecond' \t",
          'LINES="first\nsecond"  # trailing comment',
          "TOKEN=value=with=equals",
          "",
        ].join("\r\n"),
      ),
      {
        LABEL: "seed # label",
        EMPTY: "",
        MULTILINE: "first\nsecond",
        LITERAL: "first\\nsecond",
        LINES: "first\nsecond",
        TOKEN: "value=with=equals",
      },
    );
  });
});
