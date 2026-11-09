import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { generateSecretsTemplate } from "./fix-template.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

it("concurrent template repairs create one placeholder file without secret values", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kit-fix-template-"));
  t.after(() => rmTemp(root));
  const secrets = {
    template: ".env.template",
    keys: { API_KEY: { source: "config" as const, value: "synthetic-private-value" } },
  };
  const results = await Promise.all([
    generateSecretsTemplate(secrets, root),
    generateSecretsTemplate(secrets, root),
  ]);
  assert.equal(results.filter((result) => result?.written).length, 1);
  const content = await readFile(join(root, ".env.template"), "utf8");
  assert.match(content, /^API_KEY=$/m);
  assert.doesNotMatch(content, /synthetic-private-value/);
  assert.equal((await generateSecretsTemplate(secrets, root))?.written, false);
  assert.equal(await readFile(join(root, ".env.template"), "utf8"), content);
});

it("template creation reports a missing parent directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kit-fix-template-"));
  t.after(() => rmTemp(root));
  await assert.rejects(
    generateSecretsTemplate(
      { template: "missing/.env.template", keys: { API_KEY: { source: "env" } } },
      root,
    ),
    { code: "ENOENT" },
  );
});
