import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { writeOneCliPlaceholder } from "./onecli-env-file.js";

it("creates a private .env.local and replaces only the matching key", async () => {
  const project = mkdtempSync(join(tmpdir(), "kit-onecli-env-"));
  const originalCwd = process.cwd();
  try {
    process.chdir(project);
    await writeOneCliPlaceholder("API_TOKEN", "first-placeholder");
    const envPath = join(project, ".env.local");
    assert.equal(
      readFileSync(envPath, "utf8"),
      "API_TOKEN=first-placeholder  # placeholder — real value lives in OneCLI\n",
    );
    if (process.platform !== "win32") assert.equal(statSync(envPath).mode & 0o777, 0o600);

    writeFileSync(envPath, "OTHER=keep\nAPI_TOKEN=old\nOTHER_TOKEN=keep\n");
    await writeOneCliPlaceholder("API_TOKEN", "second-placeholder");
    assert.equal(
      readFileSync(envPath, "utf8"),
      "OTHER=keep\nAPI_TOKEN=second-placeholder  # placeholder — real value lives in OneCLI\nOTHER_TOKEN=keep\n",
    );
    await assert.rejects(
      writeOneCliPlaceholder("BAD\nOTHER", "injected"),
      /Invalid environment key/,
    );
    assert.equal(
      readFileSync(envPath, "utf8"),
      "OTHER=keep\nAPI_TOKEN=second-placeholder  # placeholder — real value lives in OneCLI\nOTHER_TOKEN=keep\n",
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(project, { recursive: true, force: true });
  }
});
