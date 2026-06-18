import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectSecretStore, vaultMeta, VAULT_META } from "./vault-meta.js";

describe("vault-meta", () => {
  describe("detectSecretStore", () => {
    const has = (...present: string[]) => async (p: string) => present.includes(p);

    it("detects infisical from .infisical.json", async () => {
      assert.equal(await detectSecretStore(has(".infisical.json")), "infisical");
    });

    it("detects doppler from doppler.yaml or .doppler.yaml", async () => {
      assert.equal(await detectSecretStore(has("doppler.yaml")), "doppler");
      assert.equal(await detectSecretStore(has(".doppler.yaml")), "doppler");
    });

    it("returns null when no backend marker is present", async () => {
      assert.equal(await detectSecretStore(has("package.json", "README.md")), null);
    });
  });

  describe("vaultMeta", () => {
    it("returns null for env / unknown, metadata for a real store", () => {
      assert.equal(vaultMeta("env"), null);
      assert.equal(vaultMeta(undefined), null);
      assert.equal(vaultMeta("infisical"), VAULT_META.infisical);
    });
  });
});
