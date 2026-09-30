/**
 * The unquoted keyed-secret rule took a code expression for a credential: `secret:
 * process.env.SESSION_SECRET` and `const secret = speakeasy.generateSecret({` both matched,
 * because a dotted identifier path is 20+ characters of the value class. The staged secret
 * scan runs in pre-commit, so ordinary code was blocked. A value that is an identifier path,
 * or is being called, is code, not a secret; a real unquoted token still is.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findSecrets } from "./utils/redactSecrets.js";

const keyed = (line: string) => findSecrets(line).filter((f) => f.label === "keyed-secret");

describe("keyed-secret: code expressions are not credentials", () => {
  for (const line of [
    "  secret: process.env.SESSION_SECRET,",
    "  const secret = speakeasy.generateSecret({",
    "  apiKey: config.providers.stripe.secretKey,",
    "  password = settings.database.passwordFromVault(",
  ]) {
    it(`does not flag ${JSON.stringify(line.trim())}`, () => {
      assert.deepEqual(keyed(line), []);
    });
  }

  it("still flags a real unquoted secret value", () => {
    assert.equal(keyed("api_secret: Zk3mP9qR7sT1vW5xY8aB2cD4eF6gH0jL").length, 1);
    assert.equal(keyed("password=Zk3mP9qR7sT1vW5xY8aB2cD4").length, 1);
  });
});
