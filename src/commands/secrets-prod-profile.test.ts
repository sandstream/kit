import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { cmdSecrets } from "./secrets.js";

it("refuses a prod secrets profile while the active environment is dev", async () => {
  const project = mkdtempSync(join(tmpdir(), "kit-prod-profile-"));
  const originalCwd = process.cwd();
  const originalArgv = process.argv;
  const originalProdOk = process.env.KIT_PROD_OK;
  try {
    writeFileSync(
      join(project, ".kit.toml"),
      '[env.prod.secrets]\nstore = "env"\n[env.prod.secrets.keys]\nTOKEN = { source = "config", value = "synthetic-test-value" }\n',
    );
    process.chdir(project);
    process.argv = [originalArgv[0], originalArgv[1], "secrets", "--env=prod"];
    delete process.env.KIT_PROD_OK;

    assert.equal(await cmdSecrets(), false);
    assert.equal(existsSync(join(project, ".env.local")), false);
  } finally {
    process.argv = originalArgv;
    process.chdir(originalCwd);
    if (originalProdOk === undefined) delete process.env.KIT_PROD_OK;
    else process.env.KIT_PROD_OK = originalProdOk;
    rmSync(project, { recursive: true, force: true });
  }
});
