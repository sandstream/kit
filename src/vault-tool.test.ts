import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { KIT_FEATURES } from "./kit-features.js";
import { buildStatuslineParts } from "./statusline.js";
import { rmTemp } from "./temp-cleanup.test-support.js";
import { vaultToolFor } from "./vault-tool.js";

describe("vaultToolFor: the CLI a vault is logged in through", () => {
  it("names the tool of a vault that has a CLI login", () => {
    assert.equal(vaultToolFor("infisical"), "infisical");
    assert.equal(vaultToolFor("1password"), "op");
    assert.equal(vaultToolFor("bitwarden"), "bw");
    assert.equal(vaultToolFor("aws-sm"), "aws");
  });

  it("names none for a store without a CLI login, an unknown store, or no store", () => {
    for (const store of ["env", "dotenvx", "config", "nonsense", "__proto__", "toString", ""]) {
      assert.equal(vaultToolFor(store), null, store);
    }
    assert.equal(vaultToolFor(undefined), null);
  });
});

describe("kit statusline --json: which vault the project chose", () => {
  const inProject = async (
    toml: string | null,
  ): Promise<Awaited<ReturnType<typeof buildStatuslineParts>>> => {
    const dir = mkdtempSync(join(tmpdir(), "kit-vault-"));
    const before = process.cwd();
    try {
      if (toml !== null) writeFileSync(join(dir, ".kit.toml"), toml);
      process.chdir(dir);
      return await buildStatuslineParts({ cwd: dir });
    } finally {
      process.chdir(before);
      rmTemp(dir);
    }
  };

  it("reports the chosen store and the tool behind it", async () => {
    const parts = await inProject('[secrets]\nstore = "infisical"\n');
    assert.deepEqual(parts.vault, { store: "infisical", tool: "infisical" });
  });

  it("reports a project with a .kit.toml but no store as having chosen none", async () => {
    const parts = await inProject('[tools]\nnode = "22"\n');
    assert.deepEqual(parts.vault, { store: null, tool: null });
  });

  it("reports a store without a CLI login with no tool", async () => {
    const parts = await inProject('[secrets]\nstore = "env"\n');
    assert.deepEqual(parts.vault, { store: "env", tool: null });
  });

  it("reports nothing in a folder with no .kit.toml, where setup says how to start", async () => {
    const parts = await inProject(null);
    assert.equal(parts.vault, null);
  });

  it("lists the capability, so a UI reads `vault` only from a kit that has it", () => {
    assert.ok(KIT_FEATURES.includes("vault"));
  });
});
