import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { fixture } from "../memory/pal-cli.test-support.js";

it("refuses passphrases in argv before a backup writes data", async (t) => {
  const { memory, root } = await fixture(t);
  const secret = "Copper-Wren-River-4829";
  for (const args of [["--passphrase", secret], [`--passphrase=${secret}`]]) {
    const output = join(root, "private-backup.enc");
    await assert.rejects(memory("backup", output, ...args), (error: unknown) => {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      assert.match(stderr, /refusing.*--passphrase.*argv/i);
      assert.doesNotMatch(stderr, new RegExp(secret));
      return true;
    });
    assert.equal(existsSync(output), false);
  }
});
